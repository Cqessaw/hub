"""Модуль 3: фотофіксація їжі — стрічка фото, теги «солодке / звичайне», стрік без солодкого."""

from __future__ import annotations

import secrets
from datetime import date, datetime, timedelta
from typing import Any

from . import config
from .db import connect, iso, today

SWEET = "sweet"
PLAIN = "plain"
TAGS = {SWEET: "Солодке", PLAIN: "Звичайне"}

_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
}


def normalize_tag(tag: str | None) -> str | None:
    if tag is None:
        return None
    tag = tag.strip().lower()
    if tag in {"", "none", "null"}:
        return None
    if tag in TAGS:
        return tag
    raise ValueError(f"Невідомий тег: {tag!r}")


def save_photo(data: bytes, media_type: str = "image/jpeg") -> str:
    """Кладе байти у data/photos і повертає ім'я файлу."""
    config.ensure_dirs()
    ext = _EXT_BY_MIME.get(media_type.lower(), ".jpg")
    name = f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(3)}{ext}"
    (config.PHOTO_DIR / name).write_bytes(data)
    return name


def add_entry(
    photo_path: str | None,
    moment: datetime | None = None,
    tag: str | None = None,
    note: str = "",
    source: str = "telegram",
    suggested_tag: str | None = None,
    suggestion_note: str = "",
) -> int:
    moment = moment or datetime.now()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO food_logs (timestamp, date, photo_path, tag, note, source, suggested_tag, suggestion_note) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                moment.isoformat(timespec="seconds"),
                iso(moment.date()),
                photo_path,
                normalize_tag(tag),
                note.strip(),
                source,
                normalize_tag(suggested_tag),
                suggestion_note.strip(),
            ),
        )
        return int(cur.lastrowid)


def set_tag(entry_id: int, tag: str | None) -> dict[str, Any] | None:
    with connect() as conn:
        conn.execute("UPDATE food_logs SET tag = ? WHERE id = ?", (normalize_tag(tag), entry_id))
        row = conn.execute("SELECT * FROM food_logs WHERE id = ?", (entry_id,)).fetchone()
    return dict(row) if row else None


def set_note(entry_id: int, note: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE food_logs SET note = ? WHERE id = ?", (note.strip(), entry_id))


def get_entry(entry_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM food_logs WHERE id = ?", (entry_id,)).fetchone()
    return dict(row) if row else None


def delete_entry(entry_id: int) -> None:
    entry = get_entry(entry_id)
    with connect() as conn:
        conn.execute("DELETE FROM food_logs WHERE id = ?", (entry_id,))
    if entry and entry["photo_path"]:
        path = config.PHOTO_DIR / entry["photo_path"]
        if path.exists():
            path.unlink()


# ── Стрічка й статистика ─────────────────────────────────────────────────────


def feed(limit: int = 60, before: str | None = None) -> list[dict[str, Any]]:
    """Стрічка фото, згрупована по датах, від найновіших."""
    params: list[Any] = []
    where = ""
    if before:
        where = "WHERE date < ?"
        params.append(before)
    params.append(limit)
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM food_logs {where} ORDER BY timestamp DESC LIMIT ?", params
        ).fetchall()
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        item = dict(row)
        item["tag_label"] = TAGS.get(item["tag"] or "", "Без тегу")
        grouped.setdefault(item["date"], []).append(item)
    return [
        {"date": day, "items": items, "sweets": sum(1 for i in items if i["tag"] == SWEET)}
        for day, items in grouped.items()
    ]


def latest(limit: int = 6) -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM food_logs ORDER BY timestamp DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def untagged_count() -> int:
    with connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM food_logs WHERE tag IS NULL").fetchone()
    return int(row["n"])


def sweet_days(days: int = 120, end: date | None = None) -> set[str]:
    end = end or today()
    start = end - timedelta(days=days)
    with connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT date FROM food_logs WHERE tag = ? AND date BETWEEN ? AND ?",
            (SWEET, iso(start), iso(end)),
        ).fetchall()
    return {row["date"] for row in rows}


def sweet_streak(end: date | None = None) -> dict[str, Any]:
    """Скільки днів поспіль без жодного фото з тегом «солодке».

    День без записів вважається чистим — стрік про те, чи було солодке,
    а не про те, чи ти щось фотографував.
    """
    end = end or today()
    sweets = sweet_days(365, end)
    with connect() as conn:
        first = conn.execute("SELECT MIN(date) AS d FROM food_logs").fetchone()["d"]
    if first is None:
        # Жодного запису — рахувати нічого, і «1 день» тут виглядало б обманом.
        return {"streak": 0, "last_sweet": None, "best": 0}
    floor = date.fromisoformat(first)

    count = 0
    cursor = end
    while cursor >= floor and count < 366:
        if iso(cursor) in sweets:
            break
        count += 1
        cursor -= timedelta(days=1)

    last_sweet = max(sweets) if sweets else None
    return {"streak": count, "last_sweet": last_sweet, "best": _best_streak(sweets, floor, end)}


def _best_streak(sweets: set[str], floor: date, end: date) -> int:
    best = current = 0
    cursor = floor
    while cursor <= end:
        if iso(cursor) in sweets:
            current = 0
        else:
            current += 1
            best = max(best, current)
        cursor += timedelta(days=1)
    return best


def weekly_stats(weeks: int = 8, end: date | None = None) -> list[dict[str, Any]]:
    """Скільки разів за тиждень з'являлось солодке (і скільки фото загалом)."""
    end = end or today()
    start = end - timedelta(days=weeks * 7 - 1)
    start -= timedelta(days=start.weekday())
    with connect() as conn:
        rows = conn.execute(
            "SELECT date, tag FROM food_logs WHERE date BETWEEN ? AND ?",
            (iso(start), iso(end)),
        ).fetchall()
    buckets: dict[str, dict[str, int]] = {}
    cursor = start
    while cursor <= end:
        monday = cursor - timedelta(days=cursor.weekday())
        buckets.setdefault(iso(monday), {"sweets": 0, "total": 0, "sweet_days": 0})
        cursor += timedelta(days=7)
    sweet_dates: dict[str, set[str]] = {}
    for row in rows:
        day = date.fromisoformat(row["date"])
        key = iso(day - timedelta(days=day.weekday()))
        bucket = buckets.setdefault(key, {"sweets": 0, "total": 0, "sweet_days": 0})
        bucket["total"] += 1
        if row["tag"] == SWEET:
            bucket["sweets"] += 1
            sweet_dates.setdefault(key, set()).add(row["date"])
    for key, dates in sweet_dates.items():
        buckets[key]["sweet_days"] = len(dates)
    return [{"week": week, **values} for week, values in sorted(buckets.items())]


def this_week(end: date | None = None) -> dict[str, Any]:
    end = end or today()
    monday = end - timedelta(days=end.weekday())
    with connect() as conn:
        rows = conn.execute(
            "SELECT date, tag FROM food_logs WHERE date BETWEEN ? AND ?", (iso(monday), iso(end))
        ).fetchall()
    sweets = [r for r in rows if r["tag"] == SWEET]
    return {
        "from": iso(monday),
        "photos": len(rows),
        "sweets": len(sweets),
        "sweet_days": len({r["date"] for r in sweets}),
    }
