"""Модуль 1: чек-ліст завдань — одноразові й повторювані, з відмітками і стріками."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from .db import connect, iso, today

# Правило повторення зберігається рядком:
#   'once'        — одноразова задача, видима щодня, поки не виконана
#   'daily'       — щодня
#   'days:1,3,5'  — тільки в ці дні тижня (1 = Пн ... 7 = Нд)
ONCE = "once"
DAILY = "daily"


def normalize_rule(rule: str | None) -> str:
    """Приводить правило до канонічного вигляду й відсіює сміття."""
    raw = (rule or ONCE).strip().lower()
    if raw in {"", ONCE}:
        return ONCE
    if raw == DAILY:
        return DAILY
    if raw.startswith("days:"):
        days = sorted({int(p) for p in raw[5:].replace(" ", "").split(",") if p.isdigit() and 1 <= int(p) <= 7})
        if not days:
            return DAILY
        if days == [1, 2, 3, 4, 5, 6, 7]:
            return DAILY
        return "days:" + ",".join(str(d) for d in days)
    raise ValueError(f"Невідоме правило повторення: {rule!r}")


def rule_days(rule: str) -> set[int]:
    if rule == DAILY:
        return {1, 2, 3, 4, 5, 6, 7}
    if rule.startswith("days:"):
        return {int(p) for p in rule[5:].split(",") if p}
    return set()


def is_recurring(rule: str) -> bool:
    return rule != ONCE


def is_due(rule: str, day: date) -> bool:
    """Чи стоїть задача в плані на цей день."""
    if rule == ONCE:
        return True
    return day.isoweekday() in rule_days(rule)


def describe_rule(rule: str) -> str:
    if rule == ONCE:
        return "одноразова"
    if rule == DAILY:
        return "щодня"
    names = {1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб", 7: "Нд"}
    return "/".join(names[d] for d in sorted(rule_days(rule)))


# ── CRUD ─────────────────────────────────────────────────────────────────────


def create_task(name: str, rule: str = ONCE, note: str = "") -> int:
    name = (name or "").strip()
    if not name:
        raise ValueError("Назва задачі не може бути порожньою")
    rule = normalize_rule(rule)
    with connect() as conn:
        nxt = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM tasks").fetchone()["n"]
        cur = conn.execute(
            "INSERT INTO tasks (name, recurrence_rule, note, active, sort_order, created_at) "
            "VALUES (?, ?, ?, 1, ?, ?)",
            (name, rule, note.strip(), nxt, datetime.now().isoformat(timespec="seconds")),
        )
        return int(cur.lastrowid)


def get_task(task_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    return dict(row) if row else None


def update_task(task_id: int, **fields: Any) -> None:
    allowed = {"name", "recurrence_rule", "note", "active", "sort_order"}
    sets, values = [], []
    for key, value in fields.items():
        if key not in allowed or value is None:
            continue
        if key == "recurrence_rule":
            value = normalize_rule(value)
        if key == "name":
            value = str(value).strip()
            if not value:
                raise ValueError("Назва задачі не може бути порожньою")
        if key == "active":
            value = int(bool(value))
        sets.append(f"{key} = ?")
        values.append(value)
    if not sets:
        return
    values.append(task_id)
    with connect() as conn:
        conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", values)


def delete_task(task_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM task_logs WHERE task_id = ?", (task_id,))
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))


def set_done(task_id: int, day: date, completed: bool) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO task_logs (task_id, date, completed) VALUES (?, ?, ?) "
            "ON CONFLICT(task_id, date) DO UPDATE SET completed = excluded.completed",
            (task_id, iso(day), int(bool(completed))),
        )


# ── Стріки ───────────────────────────────────────────────────────────────────


def _completed_dates(conn, task_id: int) -> set[str]:
    rows = conn.execute(
        "SELECT date FROM task_logs WHERE task_id = ? AND completed = 1", (task_id,)
    ).fetchall()
    return {row["date"] for row in rows}


def _streak(conn, task: dict[str, Any], day: date) -> int:
    """Скільки планових днів поспіль виконано, рахуючи назад від `day`.

    Сьогоднішній невиконаний день стрік не рве — він ще попереду.
    """
    rule = task["recurrence_rule"]
    if not is_recurring(rule):
        return 0
    done = _completed_dates(conn, task["id"])
    if not done:
        return 0
    # Далі за найранішу відмітку стрік тягнутись не може, тож там і зупиняємось.
    floor = min(done)

    cursor = day
    if is_due(rule, cursor) and iso(cursor) not in done:
        cursor -= timedelta(days=1)

    count = 0
    while iso(cursor) >= floor and count < 3650:
        if is_due(rule, cursor):
            if iso(cursor) in done:
                count += 1
            else:
                break
        cursor -= timedelta(days=1)
    return count


# ── Читання ──────────────────────────────────────────────────────────────────


def list_tasks(day: date | None = None, include_archived: bool = False) -> list[dict[str, Any]]:
    """Усі задачі з відміткою на конкретний день і поточним стріком."""
    day = day or today()
    where = "" if include_archived else "WHERE active = 1"
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM tasks {where} ORDER BY sort_order, id"
        ).fetchall()
        done_today = {
            r["task_id"]: bool(r["completed"])
            for r in conn.execute(
                "SELECT task_id, completed FROM task_logs WHERE date = ?", (iso(day),)
            ).fetchall()
        }
        out = []
        for row in rows:
            task = dict(row)
            rule = task["recurrence_rule"]
            task["due"] = is_due(rule, day)
            task["completed"] = done_today.get(task["id"], False)
            task["recurring"] = is_recurring(rule)
            task["rule_label"] = describe_rule(rule)
            task["streak"] = _streak(conn, task, day) if is_recurring(rule) else 0
            out.append(task)
    return out


def day_plan(day: date | None = None) -> dict[str, Any]:
    """Що заплановано на день: тільки актуальні задачі, з підсумком."""
    day = day or today()
    tasks = [t for t in list_tasks(day) if t["due"]]
    closed = _closed_before(day)
    # Одноразова задача зникає з плану наступного дня після того, як її виконали.
    visible = [t for t in tasks if t["recurring"] or t["id"] not in closed]
    done = sum(1 for t in visible if t["completed"])
    return {
        "date": iso(day),
        "tasks": visible,
        "done": done,
        "total": len(visible),
    }


def _closed_before(day: date) -> set[int]:
    """Id одноразових задач, виконаних раніше за цей день."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT l.task_id AS id FROM task_logs l JOIN tasks t ON t.id = l.task_id "
            "WHERE l.completed = 1 AND l.date < ? AND t.recurrence_rule = ?",
            (iso(day), ONCE),
        ).fetchall()
    return {row["id"] for row in rows}


def history(days: int = 84, end: date | None = None) -> dict[str, Any]:
    """Теплокарта: на кожен день — скільки задач стояло в плані і скільки виконано."""
    end = end or today()
    start = end - timedelta(days=days - 1)
    with connect() as conn:
        tasks = [dict(r) for r in conn.execute("SELECT * FROM tasks").fetchall()]
        rows = conn.execute(
            "SELECT task_id, date FROM task_logs WHERE completed = 1 AND date BETWEEN ? AND ?",
            (iso(start), iso(end)),
        ).fetchall()
        # Задачу могли завести сьогодні, а відмітки проставити заднім числом,
        # тому початком вважаємо ранішу з двох дат: створення чи першої відмітки.
        first_log = {
            r["task_id"]: r["d"]
            for r in conn.execute(
                "SELECT task_id, MIN(date) AS d FROM task_logs GROUP BY task_id"
            ).fetchall()
        }
    for task in tasks:
        created = task["created_at"][:10]
        task["start"] = min(created, first_log.get(task["id"], created))

    done_by_day: dict[str, set[int]] = {}
    for row in rows:
        done_by_day.setdefault(row["date"], set()).add(row["task_id"])

    out = []
    cursor = start
    while cursor <= end:
        key = iso(cursor)
        planned = [
            t
            for t in tasks
            if is_recurring(t["recurrence_rule"])
            and is_due(t["recurrence_rule"], cursor)
            and t["start"] <= key
        ]
        done_ids = done_by_day.get(key, set())
        done = len([t for t in planned if t["id"] in done_ids])
        extra = len(done_ids - {t["id"] for t in planned})  # одноразові теж показуємо
        out.append(
            {
                "date": key,
                "planned": len(planned),
                "done": done,
                "extra": extra,
                "ratio": (done / len(planned)) if planned else (1.0 if extra else None),
            }
        )
        cursor += timedelta(days=1)
    return {"from": iso(start), "to": iso(end), "days": out}


def log_by_dates(days: int = 30, end: date | None = None) -> list[dict[str, Any]]:
    """Проста історія списком: по датах, які задачі виконано."""
    end = end or today()
    start = end - timedelta(days=days - 1)
    with connect() as conn:
        rows = conn.execute(
            "SELECT l.date AS date, t.name AS name, t.recurrence_rule AS rule "
            "FROM task_logs l JOIN tasks t ON t.id = l.task_id "
            "WHERE l.completed = 1 AND l.date BETWEEN ? AND ? "
            "ORDER BY l.date DESC, t.sort_order",
            (iso(start), iso(end)),
        ).fetchall()
    grouped: dict[str, list[str]] = {}
    for row in rows:
        grouped.setdefault(row["date"], []).append(row["name"])
    return [{"date": d, "names": names} for d, names in grouped.items()]


def active_streaks(day: date | None = None) -> list[dict[str, Any]]:
    """Для дашборда: повторювані задачі з ненульовим стріком, найдовші зверху."""
    items = [
        {
            "id": t["id"],
            "name": t["name"],
            "streak": t["streak"],
            "rule_label": t["rule_label"],
            "due": t["due"],
            "completed": t["completed"],
        }
        for t in list_tasks(day)
        if t["recurring"]
    ]
    items.sort(key=lambda t: (-t["streak"], t["name"]))
    return items
