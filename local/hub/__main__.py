"""Точка входу: `python -m hub` піднімає дашборд і, якщо є токен, Telegram-бота.

Обидва живуть в одному циклі подій і пишуть в одну базу.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import threading
import webbrowser

import uvicorn

from . import config
from .db import init_db
from .web import app

log = logging.getLogger("hub")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m hub", description="Особистий трекер-хаб")
    parser.add_argument("--no-bot", action="store_true", help="не запускати Telegram-бота")
    parser.add_argument("--bot-only", action="store_true", help="тільки бот, без веб-дашборда")
    parser.add_argument("--open", action="store_true", help="відкрити дашборд у браузері")
    parser.add_argument("--host", default=config.HOST)
    parser.add_argument("--port", type=int, default=config.PORT)
    return parser.parse_args()


async def _run(serve_web: bool, run_bot: bool, host: str, port: int, open_browser: bool) -> None:
    init_db()

    bot_app = None
    if run_bot:
        from telegram import Update

        from .bot import build_application

        try:
            bot_app = build_application()
            await bot_app.initialize()
            await bot_app.start()
            await bot_app.updater.start_polling(allowed_updates=Update.ALL_TYPES)
            log.info("Telegram-бот на зв'язку")
        except Exception as exc:
            # Поганий токен чи немає мережі — це не привід ховати ще й дашборд.
            log.error("Бот не піднявся (%s). Дашборд працює далі, фото можна додавати з нього.", exc)
            if bot_app is not None:
                try:
                    await bot_app.shutdown()
                except Exception:
                    pass
                bot_app = None
            if not serve_web:
                raise

    try:
        if serve_web:
            if open_browser:
                threading.Timer(1.2, lambda: webbrowser.open(f"http://{host}:{port}")).start()
            server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="info"))
            await server.serve()
        else:
            log.info("Веб вимкнено, працює тільки бот. Ctrl+C щоб зупинити.")
            await asyncio.Event().wait()
    finally:
        if bot_app is not None:
            if bot_app.updater is not None and bot_app.updater.running:
                await bot_app.updater.stop()
            await bot_app.stop()
            await bot_app.shutdown()


def main() -> None:
    # Консоль Windows часто в cp1251 — без цього українські логи виглядають кракозябрами.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    args = _parse_args()

    run_bot = not args.no_bot and bool(config.TELEGRAM_TOKEN)
    if args.bot_only:
        run_bot = bool(config.TELEGRAM_TOKEN)
        if not run_bot:
            raise SystemExit("TELEGRAM_TOKEN не заданий — нема чого запускати.")
    if not run_bot and not args.no_bot and not config.TELEGRAM_TOKEN:
        log.info("TELEGRAM_TOKEN порожній — бот вимкнений, модуль «Їжа» приймає фото через дашборд.")

    serve_web = not args.bot_only
    if serve_web:
        log.info("Дашборд: http://%s:%s", args.host, args.port)

    try:
        asyncio.run(_run(serve_web, run_bot, args.host, args.port, args.open))
    except KeyboardInterrupt:
        log.info("Зупинено.")


if __name__ == "__main__":
    main()
