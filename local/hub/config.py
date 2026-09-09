"""Налаштування хабу: шляхи, порт, ключі. Читаються з .env поруч із проєктом."""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env(path: Path) -> None:
    """Мінімальний .env-читач, щоб не тягнути залежність заради десяти рядків."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        # Змінна оточення має пріоритет над файлом.
        if key and key not in os.environ:
            os.environ[key] = value


_load_env(ROOT / ".env")


def _flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on", "так"}


DATA_DIR = Path(os.getenv("HUB_DATA_DIR") or (ROOT / "data")).expanduser()
DB_PATH = DATA_DIR / "hub.sqlite3"
PHOTO_DIR = DATA_DIR / "photos"
STATIC_DIR = ROOT / "static"

HOST = os.getenv("HUB_HOST") or "127.0.0.1"
PORT = int(os.getenv("HUB_PORT") or 8765)

def _ids(raw: str) -> set[int]:
    out: set[int] = set()
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if part.lstrip("-").isdigit():
            out.add(int(part))
    return out


TELEGRAM_TOKEN = (os.getenv("TELEGRAM_TOKEN") or "").strip()
TELEGRAM_ALLOWED_IDS = _ids(os.getenv("TELEGRAM_ALLOWED_IDS") or "")

ANTHROPIC_API_KEY = (os.getenv("ANTHROPIC_API_KEY") or "").strip()
VISION_MODEL = os.getenv("HUB_VISION_MODEL") or "claude-opus-5"
VISION_ENABLED = _flag("HUB_VISION", True) and bool(ANTHROPIC_API_KEY)

# Значення за замовчуванням для таблиці settings (користувач міняє їх у дашборді).
DEFAULT_SETTINGS = {
    "sleep_goal_minutes": "480",   # бажана норма сну, хвилин
    "bedtime": "23:00",            # орієнтовний час лягати
    "sleep_warn_nights": "5",      # скільки останніх ночей дивитись у попередженні
    "wake_reminder": "",           # порожньо = без ранкового нагадування
    "telegram_chat_id": "",        # заповнюється після /start у боті
}


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PHOTO_DIR.mkdir(parents=True, exist_ok=True)
