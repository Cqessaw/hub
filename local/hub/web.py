"""Спільний локальний дашборд: FastAPI віддає статику й JSON-API всіх трьох модулів."""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date, datetime
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, food, sleep, tasks, vision
from .db import get_settings, init_db, parse_date, set_setting, today


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Хаб", docs_url="/api/docs", redoc_url=None, lifespan=lifespan)


@app.exception_handler(ValueError)
async def _bad_value(_, exc: ValueError) -> JSONResponse:
    """Свої перевірки в модулях кидають ValueError — назовні це звичайний 400."""
    return JSONResponse({"detail": str(exc)}, status_code=400)


# ── Моделі запитів ───────────────────────────────────────────────────────────


class TaskIn(BaseModel):
    name: str
    recurrence_rule: str = "once"
    note: str = ""


class TaskPatch(BaseModel):
    name: str | None = None
    recurrence_rule: str | None = None
    note: str | None = None
    active: bool | None = None
    sort_order: int | None = None


class ToggleIn(BaseModel):
    date: str | None = None
    completed: bool = True


class NightIn(BaseModel):
    sleep_time: str | None = None
    wake_time: str | None = None
    quality: int | None = Field(default=None, ge=0, le=5)
    note: str | None = None


class FoodPatch(BaseModel):
    tag: str | None = None
    note: str | None = None


# ── Дашборд ──────────────────────────────────────────────────────────────────


@app.get("/api/dashboard")
def dashboard(day: str | None = Query(default=None)) -> dict[str, Any]:
    when = parse_date(day)
    plan = tasks.day_plan(when)
    streaks = [s for s in tasks.active_streaks(when) if s["streak"] > 0][:6]
    return {
        "date": plan["date"],
        "tasks": {
            "done": plan["done"],
            "total": plan["total"],
            "streaks": streaks,
            "items": plan["tasks"],
        },
        "sleep": {
            "week": sleep.nights(7, when),
            "stats": sleep.stats(7, when),
            "advisor": sleep.advisor(),
        },
        "food": {
            "streak": food.sweet_streak(when),
            "week": food.this_week(when),
            "latest": food.latest(6),
            "untagged": food.untagged_count(),
        },
    }


# ── Модуль 1: задачі ─────────────────────────────────────────────────────────


@app.get("/api/tasks")
def api_tasks(day: str | None = None, all: bool = False) -> dict[str, Any]:
    when = parse_date(day)
    if all:
        return {"date": when.isoformat(), "tasks": tasks.list_tasks(when, include_archived=True)}
    return tasks.day_plan(when)


@app.post("/api/tasks")
def api_task_create(body: TaskIn) -> dict[str, Any]:
    return {"id": tasks.create_task(body.name, body.recurrence_rule, body.note)}


@app.patch("/api/tasks/{task_id}")
def api_task_update(task_id: int, body: TaskPatch) -> dict[str, str]:
    if tasks.get_task(task_id) is None:
        raise HTTPException(404, "Такої задачі немає")
    tasks.update_task(task_id, **body.model_dump(exclude_none=True))
    return {"status": "ok"}


@app.delete("/api/tasks/{task_id}")
def api_task_delete(task_id: int) -> dict[str, str]:
    tasks.delete_task(task_id)
    return {"status": "ok"}


@app.post("/api/tasks/{task_id}/toggle")
def api_task_toggle(task_id: int, body: ToggleIn) -> dict[str, Any]:
    if tasks.get_task(task_id) is None:
        raise HTTPException(404, "Такої задачі немає")
    when = parse_date(body.date)
    tasks.set_done(task_id, when, body.completed)
    return tasks.day_plan(when)


@app.get("/api/tasks/history")
def api_task_history(days: int = Query(default=84, ge=7, le=370)) -> dict[str, Any]:
    return {"heatmap": tasks.history(days), "list": tasks.log_by_dates(min(days, 60))}


# ── Модуль 2: сон ────────────────────────────────────────────────────────────


@app.get("/api/sleep")
def api_sleep(days: int = Query(default=30, ge=7, le=370)) -> dict[str, Any]:
    return {
        "nights": sleep.nights(days),
        "weekly": sleep.weekly_average(max(4, days // 7)),
        "stats": {"week": sleep.stats(7), "month": sleep.stats(30)},
        "advisor": sleep.advisor(),
    }


@app.post("/api/sleep/bed")
def api_sleep_bed() -> dict[str, Any]:
    return {"night": sleep.mark_bed(), "advisor": sleep.advisor()}


@app.post("/api/sleep/wake")
def api_sleep_wake() -> dict[str, Any]:
    return {"night": sleep.mark_wake(), "advisor": sleep.advisor()}


@app.put("/api/sleep/{night}")
def api_sleep_save(night: str, body: NightIn) -> dict[str, Any]:
    try:
        when = date.fromisoformat(night)
    except ValueError as exc:
        raise HTTPException(400, "Дата має бути у форматі YYYY-MM-DD") from exc
    return sleep.save_night(when, body.sleep_time, body.wake_time, body.quality, body.note)


@app.delete("/api/sleep/{night}")
def api_sleep_delete(night: str) -> dict[str, str]:
    sleep.delete_night(date.fromisoformat(night))
    return {"status": "ok"}


# ── Модуль 3: їжа ────────────────────────────────────────────────────────────


@app.get("/api/food")
def api_food(limit: int = Query(default=60, ge=1, le=300), before: str | None = None) -> dict[str, Any]:
    return {
        "feed": food.feed(limit, before),
        "streak": food.sweet_streak(),
        "week": food.this_week(),
        "weekly": food.weekly_stats(8),
        "vision": vision.available(),
    }


@app.get("/api/food/{entry_id}/photo")
def api_food_photo(entry_id: int) -> FileResponse:
    entry = food.get_entry(entry_id)
    if not entry or not entry["photo_path"]:
        raise HTTPException(404, "Фото немає")
    path = config.PHOTO_DIR / entry["photo_path"]
    if not path.exists():
        raise HTTPException(404, "Файл фото загубився")
    return FileResponse(path)


@app.patch("/api/food/{entry_id}")
def api_food_patch(entry_id: int, body: FoodPatch) -> dict[str, Any]:
    if not food.get_entry(entry_id):
        raise HTTPException(404, "Запису немає")
    if body.tag is not None:
        food.set_tag(entry_id, body.tag)
    if body.note is not None:
        food.set_note(entry_id, body.note)
    return {"entry": food.get_entry(entry_id), "streak": food.sweet_streak()}


@app.delete("/api/food/{entry_id}")
def api_food_delete(entry_id: int) -> dict[str, str]:
    food.delete_entry(entry_id)
    return {"status": "ok"}


@app.post("/api/food/upload")
async def api_food_upload(photo: UploadFile = File(...), tag: str | None = None) -> dict[str, Any]:
    """Запасний вхід без бота — закинути фото прямо з дашборда."""
    data = await photo.read()
    if not data:
        raise HTTPException(400, "Порожній файл")
    name = food.save_photo(data, photo.content_type or "image/jpeg")
    entry_id = food.add_entry(name, tag=tag, source="web")
    return {"id": entry_id, "entry": food.get_entry(entry_id)}


# ── Налаштування ─────────────────────────────────────────────────────────────


@app.get("/api/settings")
def api_settings() -> dict[str, Any]:
    values = get_settings()
    return {
        "settings": values,
        "telegram": bool(config.TELEGRAM_TOKEN),
        "vision": vision.available(),
    }


@app.get("/api/backup")
def api_backup(photos: int = Query(default=1, ge=0, le=1)) -> dict[str, Any]:
    """Копія у тому самому форматі, який читає PWA — щоб перенести дані на телефон."""
    import base64
    import mimetypes

    from .db import connect

    with connect() as conn:
        tasks = [dict(r) for r in conn.execute("SELECT * FROM tasks ORDER BY sort_order, id")]
        logs = [dict(r) for r in conn.execute("SELECT * FROM task_logs")]
        nights = [dict(r) for r in conn.execute("SELECT * FROM sleep_logs ORDER BY date")]
        meals = [dict(r) for r in conn.execute("SELECT * FROM food_logs ORDER BY timestamp")]

    out_food = []
    for meal in meals:
        photo = None
        mime = "image/jpeg"
        if meal["photo_path"]:
            mime = mimetypes.guess_type(meal["photo_path"])[0] or "image/jpeg"
        if photos and meal["photo_path"]:
            path = config.PHOTO_DIR / meal["photo_path"]
            if path.exists():
                photo = f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")
        out_food.append(
            {
                "ts": meal["timestamp"][:16],
                "date": meal["date"],
                "tag": meal["tag"],
                "note": meal["note"],
                "source": meal["source"],
                "type": mime,
                "photo": photo,
            }
        )

    values = get_settings()
    return {
        "app": "hub",
        "version": 1,
        "exportedAt": datetime.now().isoformat(timespec="seconds"),
        "withPhotos": bool(photos),
        "tasks": tasks,
        "taskLogs": [{"taskId": r["task_id"], "date": r["date"], "completed": bool(r["completed"])} for r in logs],
        "sleep": nights,
        "food": out_food,
        "settings": {
            "sleepGoalMinutes": int(values.get("sleep_goal_minutes", 480)),
            "bedtime": values.get("bedtime", "23:00"),
            "warnNights": int(values.get("sleep_warn_nights", 5)),
        },
    }


@app.put("/api/settings")
def api_settings_save(body: dict[str, str] = Body(...)) -> dict[str, Any]:
    editable = {"sleep_goal_minutes", "bedtime", "sleep_warn_nights", "wake_reminder"}
    for key, value in body.items():
        if key in editable:
            set_setting(key, str(value))
    return {"settings": get_settings()}


# ── Статика ──────────────────────────────────────────────────────────────────


@app.get("/")
def index() -> FileResponse:
    return FileResponse(config.STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> JSONResponse:
    return JSONResponse({"ok": True, "today": today().isoformat(), "now": datetime.now().isoformat(timespec="seconds")})


app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
