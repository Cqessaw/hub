"""Модуль 2: помічник для сну — дві кнопки «зараз», графік і попередження про недосип."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any

from .db import connect, get_setting, iso, today


def night_date(moment: datetime) -> date:
    """Дата ночі, до якої належить момент.

    Ліг о 23:40 — це ніч поточної дати. Ліг о 01:20 — це ще попередня ніч.
    """
    return moment.date() if moment.hour >= 12 else moment.date() - timedelta(days=1)


def _combine(night: date, hhmm: str, kind: str) -> str:
    """З 'HH:MM' робить повний ISO-час на потрібній добі.

    Засинання до полудня вважається наступною добою після ночі; прокидання
    після 18:00 — тією самою добою, інакше наступною.
    """
    hour, minute = (int(p) for p in hhmm.split(":")[:2])
    if kind == "sleep":
        day = night if hour >= 12 else night + timedelta(days=1)
    else:
        day = night if hour >= 18 else night + timedelta(days=1)
    return datetime.combine(day, time(hour, minute)).isoformat(timespec="minutes")


def _duration(sleep_time: str | None, wake_time: str | None) -> int | None:
    if not sleep_time or not wake_time:
        return None
    minutes = int((datetime.fromisoformat(wake_time) - datetime.fromisoformat(sleep_time)).total_seconds() // 60)
    if minutes <= 0 or minutes > 24 * 60:
        return None
    return minutes


def _refresh(conn, night: date) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM sleep_logs WHERE date = ?", (iso(night),)).fetchone()
    if row is None:
        return {}
    duration = _duration(row["sleep_time"], row["wake_time"])
    conn.execute("UPDATE sleep_logs SET duration = ? WHERE id = ?", (duration, row["id"]))
    row = conn.execute("SELECT * FROM sleep_logs WHERE id = ?", (row["id"],)).fetchone()
    return dict(row)


def mark_bed(moment: datetime | None = None) -> dict[str, Any]:
    """Кнопка «ліг спати» — записує поточний час у потрібну ніч."""
    moment = moment or datetime.now()
    night = night_date(moment)
    stamp = moment.isoformat(timespec="minutes")
    with connect() as conn:
        conn.execute(
            "INSERT INTO sleep_logs (date, sleep_time) VALUES (?, ?) "
            "ON CONFLICT(date) DO UPDATE SET sleep_time = excluded.sleep_time",
            (iso(night), stamp),
        )
        return _refresh(conn, night)


def mark_wake(moment: datetime | None = None) -> dict[str, Any]:
    """Кнопка «прокинувся» — закриває останню відкриту ніч."""
    moment = moment or datetime.now()
    stamp = moment.isoformat(timespec="minutes")
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM sleep_logs WHERE sleep_time IS NOT NULL AND wake_time IS NULL "
            "ORDER BY date DESC LIMIT 1"
        ).fetchone()
        night = date.fromisoformat(row["date"]) if row is not None else None
        if night is None or _duration(row["sleep_time"], stamp) is None:
            # Немає відкритої ночі (або вона надто давня) — заводимо запис самі.
            night = moment.date() - timedelta(days=1) if moment.hour < 18 else moment.date()
            conn.execute(
                "INSERT INTO sleep_logs (date, wake_time) VALUES (?, ?) "
                "ON CONFLICT(date) DO UPDATE SET wake_time = excluded.wake_time",
                (iso(night), stamp),
            )
        else:
            conn.execute("UPDATE sleep_logs SET wake_time = ? WHERE id = ?", (stamp, row["id"]))
        return _refresh(conn, night)


def save_night(
    night: date,
    sleep_time: str | None = None,
    wake_time: str | None = None,
    quality: int | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """Ручне редагування ночі. Час приймається як 'HH:MM' або повний ISO."""
    def norm(value: str | None, kind: str) -> str | None:
        if value is None or value == "":
            return None
        return _combine(night, value, kind) if len(value) <= 5 else value

    with connect() as conn:
        conn.execute("INSERT INTO sleep_logs (date) VALUES (?) ON CONFLICT(date) DO NOTHING", (iso(night),))
        sets, values = [], []
        if sleep_time is not None:
            sets.append("sleep_time = ?")
            values.append(norm(sleep_time, "sleep"))
        if wake_time is not None:
            sets.append("wake_time = ?")
            values.append(norm(wake_time, "wake"))
        if quality is not None:
            sets.append("quality = ?")
            values.append(max(1, min(5, int(quality))) if quality else None)
        if note is not None:
            sets.append("note = ?")
            values.append(note.strip())
        if sets:
            values.append(iso(night))
            conn.execute(f"UPDATE sleep_logs SET {', '.join(sets)} WHERE date = ?", values)
        return _refresh(conn, night)


def delete_night(night: date) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM sleep_logs WHERE date = ?", (iso(night),))


def nights(days: int = 30, end: date | None = None) -> list[dict[str, Any]]:
    """Ряд ночей за період — без пропусків, щоб графік не «стискався»."""
    end = end or today()
    start = end - timedelta(days=days - 1)
    with connect() as conn:
        rows = {
            r["date"]: dict(r)
            for r in conn.execute(
                "SELECT * FROM sleep_logs WHERE date BETWEEN ? AND ? ORDER BY date",
                (iso(start), iso(end)),
            ).fetchall()
        }
    out = []
    cursor = start
    while cursor <= end:
        key = iso(cursor)
        row = rows.get(key) or {"date": key, "sleep_time": None, "wake_time": None, "duration": None, "quality": None, "note": ""}
        out.append(row)
        cursor += timedelta(days=1)
    return out


def weekly_average(weeks: int = 8, end: date | None = None) -> list[dict[str, Any]]:
    """Середня тривалість по тижнях — для помісячного погляду на графік."""
    end = end or today()
    start = end - timedelta(days=weeks * 7 - 1)
    rows = [n for n in nights((end - start).days + 1, end) if n["duration"]]
    buckets: dict[str, list[int]] = {}
    for row in rows:
        day = date.fromisoformat(row["date"])
        monday = day - timedelta(days=day.weekday())
        buckets.setdefault(iso(monday), []).append(row["duration"])
    return [
        {"week": week, "avg": round(sum(values) / len(values)), "nights": len(values)}
        for week, values in sorted(buckets.items())
    ]


def stats(days: int = 7, end: date | None = None) -> dict[str, Any]:
    rows = [n for n in nights(days, end) if n["duration"]]
    if not rows:
        return {"nights": 0, "avg": None, "min": None, "max": None, "avg_quality": None}
    durations = [r["duration"] for r in rows]
    qualities = [r["quality"] for r in rows if r["quality"]]
    return {
        "nights": len(rows),
        "avg": round(sum(durations) / len(durations)),
        "min": min(durations),
        "max": max(durations),
        "avg_quality": round(sum(qualities) / len(qualities), 1) if qualities else None,
    }


# ── Помічник ─────────────────────────────────────────────────────────────────


def _goal() -> int:
    try:
        return max(60, int(get_setting("sleep_goal_minutes", "480")))
    except ValueError:
        return 480


def _bedtime() -> str:
    value = (get_setting("bedtime", "23:00") or "").strip()
    try:
        hour, minute = (int(p) for p in value.split(":")[:2])
        return f"{hour:02d}:{minute:02d}"
    except (ValueError, IndexError):
        return "23:00"


def advisor(now: datetime | None = None) -> dict[str, Any]:
    """Що помічник має сказати просто зараз: чи час лягати і чи є недосип."""
    now = now or datetime.now()
    goal = _goal()
    bedtime = _bedtime()
    window = max(1, int(get_setting("sleep_warn_nights", "5") or 5))

    recent = [n for n in nights(window, now.date()) if n["duration"]]
    avg = round(sum(n["duration"] for n in recent) / len(recent)) if recent else None
    short_nights = [n for n in recent if n["duration"] < goal - 20]
    deficit = bool(recent) and len(recent) >= 3 and avg is not None and avg < goal - 20

    hour, minute = (int(p) for p in bedtime.split(":"))
    bed_dt = datetime.combine(now.date(), time(hour, minute))
    if now > bed_dt + timedelta(hours=6):  # вже далеко за північ — рахуємо на завтра
        bed_dt += timedelta(days=1)
    minutes_to_bed = int((bed_dt - now).total_seconds() // 60)

    tonight = None
    with connect() as conn:
        row = conn.execute("SELECT * FROM sleep_logs WHERE date = ?", (iso(night_date(now)),)).fetchone()
        if row is not None:
            tonight = dict(row)

    messages = []
    if 0 <= minutes_to_bed <= 45:
        messages.append(f"До орієнтовного відбою о {bedtime} лишилось {minutes_to_bed} хв.")
    elif minutes_to_bed < 0:
        messages.append(f"Час відбою о {bedtime} вже минув {-minutes_to_bed} хв тому.")
    if deficit:
        messages.append(
            f"Останні {len(recent)} ночей у середньому {fmt(avg)} — це менше за норму {fmt(goal)}."
        )

    return {
        "goal_minutes": goal,
        "bedtime": bedtime,
        "minutes_to_bed": minutes_to_bed,
        "bed_due": minutes_to_bed <= 0 or minutes_to_bed <= 45,
        "avg_recent": avg,
        "recent_nights": len(recent),
        "short_nights": len(short_nights),
        "deficit": deficit,
        "tonight": tonight,
        "messages": messages,
    }


def fmt(minutes: int | None) -> str:
    """480 → '8 год 00 хв'."""
    if not minutes:
        return "—"
    return f"{minutes // 60} год {minutes % 60:02d} хв"
