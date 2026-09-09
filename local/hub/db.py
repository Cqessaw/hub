"""Доступ до SQLite. Одна база на всі модулі, з'єднання відкривається на операцію."""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterator

from . import config

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """З'єднання з базою. WAL — щоб веб і бот могли писати одночасно."""
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    """Створює таблиці й доливає значення налаштувань за замовчуванням."""
    with connect() as conn:
        conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        for key, value in config.DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO NOTHING",
                (key, value),
            )


# ── Налаштування ─────────────────────────────────────────────────────────────


def get_settings() -> dict[str, str]:
    with connect() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    merged = dict(config.DEFAULT_SETTINGS)
    merged.update({row["key"]: row["value"] for row in rows})
    return merged


def get_setting(key: str, fallback: str = "") -> str:
    with connect() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is not None:
        return row["value"]
    return config.DEFAULT_SETTINGS.get(key, fallback)


def set_setting(key: str, value: str) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )


# ── Дрібні хелпери дат ───────────────────────────────────────────────────────


def today() -> date:
    return datetime.now().date()


def iso(d: date) -> str:
    return d.isoformat()


def parse_date(value: str | None, default: date | None = None) -> date:
    if not value:
        return default or today()
    return date.fromisoformat(value)


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None
