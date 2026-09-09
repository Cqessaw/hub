"""Telegram-бот: найшвидший спосіб закинути фото їжі й отримати нагадування про сон.

Пише в ту саму SQLite-базу, що й дашборд. Запускається разом із сервером
(`python -m hub`) або окремо (`python -m hub --bot-only`).
"""

from __future__ import annotations

import asyncio
import html
import logging
from datetime import date, datetime, timedelta

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.error import BadRequest
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from . import config, food, sleep, tasks, vision
from .db import get_setting, init_db, set_setting, today

log = logging.getLogger(__name__)


def esc(text: object) -> str:
    """Назви задач і підказки пише користувач — у HTML-режимі їх треба екранувати."""
    return html.escape(str(text), quote=False)


# ── Доступ ───────────────────────────────────────────────────────────────────


def _allowed(update: Update) -> bool:
    """Бот особистий: або список у .env, або перший, хто написав /start."""
    user = update.effective_user
    if user is None:
        return False
    if config.TELEGRAM_ALLOWED_IDS:
        return user.id in config.TELEGRAM_ALLOWED_IDS
    owner = get_setting("telegram_user_id", "")
    if not owner:
        return True  # ще нікого не записано — власником стане перший
    return str(user.id) == owner


def _remember_owner(update: Update) -> None:
    user, chat = update.effective_user, update.effective_chat
    if user is None or chat is None:
        return
    if not get_setting("telegram_user_id", ""):
        set_setting("telegram_user_id", str(user.id))
    set_setting("telegram_chat_id", str(chat.id))


# ── Команди ──────────────────────────────────────────────────────────────────


async def cmd_start(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        await update.message.reply_text("Цей бот особистий.")
        return
    _remember_owner(update)
    await update.message.reply_text(
        "Хаб на зв'язку.\n\n"
        "• Надішли фото їжі — я збережу його і спитаю тег.\n"
        "• /sleep — кнопки «ліг спати» / «прокинувся».\n"
        "• /streak — усі стріки одним повідомленням.\n"
        "• /today — план задач на сьогодні.\n\n"
        f"Дашборд: http://{config.HOST}:{config.PORT}"
    )


async def cmd_streak(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    await update.message.reply_text(_streak_report(), parse_mode="HTML")


def _streak_report() -> str:
    lines = ["<b>Стріки</b>"]
    active = [s for s in tasks.active_streaks() if s["streak"] > 0]
    if active:
        for item in active[:8]:
            mark = "✅" if item["completed"] else ("⬜" if item["due"] else "·")
            lines.append(f"{mark} {esc(item['name'])} — {item['streak']} дн.")
    else:
        lines.append("Задачі: жодного активного стріку.")

    sweet = food.sweet_streak()
    lines.append("")
    lines.append(f"🍰 Без солодкого: <b>{sweet['streak']}</b> дн. (рекорд {sweet['best']})")

    week = sleep.stats(7)
    if week["avg"]:
        lines.append(f"😴 Сон за тиждень: у середньому {sleep.fmt(week['avg'])}")
    return "\n".join(lines)


async def cmd_today(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    plan = tasks.day_plan()
    if not plan["tasks"]:
        await update.message.reply_text("На сьогодні задач немає.")
        return
    lines = [f"<b>Сьогодні {plan['done']}/{plan['total']}</b>"]
    for item in plan["tasks"]:
        mark = "✅" if item["completed"] else "⬜"
        streak = f" · {item['streak']} дн." if item["streak"] else ""
        lines.append(f"{mark} {esc(item['name'])}{streak}")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


def _sleep_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("🌙 Ліг спати", callback_data="sleep:bed"),
                InlineKeyboardButton("☀️ Прокинувся", callback_data="sleep:wake"),
            ]
        ]
    )


async def cmd_sleep(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    _remember_owner(update)
    advice = sleep.advisor()
    text = ["<b>Сон</b>"]
    tonight = advice["tonight"]
    if tonight and tonight.get("sleep_time"):
        text.append(f"Сьогодні ліг о {tonight['sleep_time'][11:16]}.")
    if advice["avg_recent"]:
        text.append(f"Останні {advice['recent_nights']} ночей: {sleep.fmt(advice['avg_recent'])}.")
    text.extend(advice["messages"])
    await update.message.reply_text("\n".join(text), parse_mode="HTML", reply_markup=_sleep_keyboard())


# ── Фото їжі ─────────────────────────────────────────────────────────────────


def _tag_keyboard(entry_id: int, suggested: str | None = None) -> InlineKeyboardMarkup:
    labels = {"sweet": "🍰 Солодке", "plain": "🥗 Звичайне"}
    row = []
    for tag, label in labels.items():
        if suggested == tag:
            label = "✓ " + label
        row.append(InlineKeyboardButton(label, callback_data=f"tag:{entry_id}:{tag}"))
    return InlineKeyboardMarkup([row, [InlineKeyboardButton("🗑 Прибрати", callback_data=f"drop:{entry_id}")]])


async def on_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    _remember_owner(update)
    message = update.message

    if message.photo:
        file_id = message.photo[-1].file_id
        media_type = "image/jpeg"
    else:
        document = message.document
        file_id = document.file_id
        media_type = document.mime_type or "image/jpeg"

    telegram_file = await context.bot.get_file(file_id)
    data = bytes(await telegram_file.download_as_bytearray())
    name = food.save_photo(data, media_type)

    suggestion = None
    if vision.available():
        suggestion = await asyncio.to_thread(vision.suggest_tag, data, "image/jpeg")

    entry_id = food.add_entry(
        name,
        note=(message.caption or "").strip(),
        source="telegram",
        suggested_tag=suggestion["tag"] if suggestion else None,
        suggestion_note=suggestion["item"] if suggestion else "",
    )

    lines = [f"Фото збережено · {datetime.now():%H:%M}"]
    if suggestion:
        label = "солодке" if suggestion["tag"] == "sweet" else "звичайне"
        item = suggestion["item"] or "страва"
        lines.append(f"Схоже на: {esc(item)} → <i>{label}</i>")
        lines.append("Підтверди або виправ:")
    else:
        lines.append("Що це?")
    await message.reply_text(
        "\n".join(lines),
        parse_mode="HTML",
        reply_markup=_tag_keyboard(entry_id, suggestion["tag"] if suggestion else None),
    )


async def on_callback(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None:
        return
    if not _allowed(update):
        await query.answer("Не для цього акаунта.", show_alert=True)
        return

    data = query.data or ""
    try:
        if data.startswith("tag:"):
            _, raw_id, tag = data.split(":", 2)
            entry = food.set_tag(int(raw_id), tag)
            if entry is None:
                await query.answer("Запис уже видалено.")
                return
            streak = food.sweet_streak()
            label = food.TAGS[tag]
            note = f"{'🍰' if tag == 'sweet' else '🥗'} {label} · {entry['timestamp'][11:16]}"
            if tag == "sweet":
                note += "\nСтрік без солодкого обнулився."
            else:
                note += f"\nБез солодкого: {streak['streak']} дн."
            await query.answer(label)
            await query.edit_message_text(note, parse_mode="HTML")

        elif data.startswith("drop:"):
            food.delete_entry(int(data.split(":", 1)[1]))
            await query.answer("Прибрано")
            await query.edit_message_text("Запис видалено.")

        elif data == "sleep:bed":
            night = sleep.mark_bed()
            await query.answer("Добраніч")
            await query.edit_message_text(
                f"🌙 Ліг о {night['sleep_time'][11:16]}. Добраніч.", reply_markup=_sleep_keyboard()
            )

        elif data == "sleep:wake":
            night = sleep.mark_wake()
            duration = sleep.fmt(night.get("duration"))
            await query.answer("Доброго ранку")
            await query.edit_message_text(
                f"☀️ Прокинувся о {night['wake_time'][11:16]}. Сон: {duration}.",
                reply_markup=_quality_keyboard(night["date"]),
            )

        elif data.startswith("q:"):
            _, night, value = data.split(":", 2)
            sleep.save_night(date.fromisoformat(night), quality=int(value))
            await query.answer("Записав")
            await query.edit_message_text(f"Оцінка сну за ніч {night}: {'★' * int(value)}")
    except BadRequest as exc:  # повідомлення не змінилось або застаріло
        log.debug("Callback не оновив повідомлення: %s", exc)
    except Exception as exc:
        log.exception("Помилка обробки кнопки: %s", exc)
        await query.answer("Щось пішло не так", show_alert=True)


def _quality_keyboard(night: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [[InlineKeyboardButton("★" * n, callback_data=f"q:{night}:{n}") for n in range(1, 6)]]
    )


# ── Нагадування ──────────────────────────────────────────────────────────────


def _minutes(hhmm: str) -> int | None:
    try:
        hour, minute = (int(p) for p in hhmm.split(":")[:2])
        return hour * 60 + minute
    except (ValueError, IndexError):
        return None


async def reminder_tick(context: ContextTypes.DEFAULT_TYPE) -> None:
    """Раз на п'ять хвилин перевіряє, чи не час нагадати. Читає налаштування щоразу,
    тому зміна часу відбою в дашборді діє одразу, без перезапуску бота."""
    chat_id = get_setting("telegram_chat_id", "")
    if not chat_id:
        return
    now = datetime.now()
    now_minutes = now.hour * 60 + now.minute
    stamp = today().isoformat()

    bedtime = _minutes(get_setting("bedtime", "23:00"))
    if bedtime is not None and 0 <= now_minutes - bedtime <= 45:
        if get_setting("last_bed_reminder", "") != stamp:
            set_setting("last_bed_reminder", stamp)
            advice = sleep.advisor(now)
            lines = [f"🌙 Час лягати — орієнтир {advice['bedtime']}."]
            if advice["deficit"]:
                lines.append(
                    f"За останні {advice['recent_nights']} ночей у середньому "
                    f"{sleep.fmt(advice['avg_recent'])}, а норма {sleep.fmt(advice['goal_minutes'])}. "
                    "Варто лягти раніше."
                )
            await context.bot.send_message(chat_id, "\n".join(lines), reply_markup=_sleep_keyboard())

    wake = _minutes(get_setting("wake_reminder", ""))
    if wake is not None and 0 <= now_minutes - wake <= 20:
        if get_setting("last_wake_reminder", "") != stamp:
            set_setting("last_wake_reminder", stamp)
            night = sleep.night_date(now - timedelta(hours=12))
            await context.bot.send_message(
                chat_id,
                "☀️ Доброго ранку. Як спалось?",
                reply_markup=_quality_keyboard(night.isoformat()),
            )


# ── Збирання застосунку ──────────────────────────────────────────────────────


def build_application() -> Application:
    if not config.TELEGRAM_TOKEN:
        raise RuntimeError("TELEGRAM_TOKEN не заданий — бот не може стартувати")
    init_db()
    app = Application.builder().token(config.TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_start))
    app.add_handler(CommandHandler("streak", cmd_streak))
    app.add_handler(CommandHandler("today", cmd_today))
    app.add_handler(CommandHandler("sleep", cmd_sleep))
    app.add_handler(MessageHandler(filters.PHOTO | filters.Document.IMAGE, on_photo))
    app.add_handler(CallbackQueryHandler(on_callback))

    if app.job_queue is not None:
        app.job_queue.run_repeating(reminder_tick, interval=300, first=30, name="reminders")
    else:
        log.warning("JobQueue недоступна — нагадувань не буде. Постав python-telegram-bot[job-queue].")
    return app


def run_forever() -> None:
    """Окремий процес: тільки бот."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    build_application().run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    run_forever()
