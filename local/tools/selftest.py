"""Швидка перевірка логіки всіх трьох модулів на тимчасовій базі.

Запуск:  python tools/selftest.py
Нічого не чіпає в data/ — працює у власній тимчасовій теці.
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

# Консоль Windows не завжди тягне юнікодні позначки — переводимо вивід у UTF-8.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

TMP = Path(tempfile.mkdtemp(prefix="hub-selftest-"))
os.environ["HUB_DATA_DIR"] = str(TMP)
os.environ["HUB_VISION"] = "0"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hub import food, sleep, tasks  # noqa: E402
from hub.db import init_db  # noqa: E402

ok = True


def check(label: str, got, expected) -> None:
    global ok
    good = got == expected
    ok = ok and good
    print(f"{'[ok]' if good else '[!!]'} {label}: {got}" + ("" if good else f"  (очікувалось {expected})"))


init_db()
today = date.today()

# ── Модуль 1: задачі ────────────────────────────────────────────────────────
print("\n--- Задачі ---")
gym = tasks.create_task("Зал", "days:1,3,5")
water = tasks.create_task("Вода", "daily")
once = tasks.create_task("Замовити окуляри", "once")

check("правило днів нормалізується", tasks.normalize_rule("days:5,1,3,3"), "days:1,3,5")
check("усі сім днів = daily", tasks.normalize_rule("days:1,2,3,4,5,6,7"), "daily")
check("підпис правила", tasks.describe_rule("days:1,3,5"), "Пн/Ср/Пт")

# Щоденну виконано п'ять днів поспіль, включно з учора.
for back in range(1, 6):
    tasks.set_done(water, today - timedelta(days=back), True)
streaks = {t["name"]: t["streak"] for t in tasks.list_tasks(today)}
check("стрік щоденної задачі", streaks["Вода"], 5)

# Сьогодні ще не відмічено — стрік не має впасти.
tasks.set_done(water, today, True)
check("стрік після відмітки сьогодні", {t["name"]: t["streak"] for t in tasks.list_tasks(today)}["Вода"], 6)

# Пропуск позаминулого дня ріже стрік.
tasks.set_done(water, today - timedelta(days=3), False)
check("пропуск ріже стрік", {t["name"]: t["streak"] for t in tasks.list_tasks(today)}["Вода"], 3)

# Задача на конкретні дні видима тільки в ці дні.
monday = today - timedelta(days=today.weekday())
check("зал у понеділок у плані", any(t["name"] == "Зал" for t in tasks.day_plan(monday)["tasks"]), True)
check("зал у вівторок не в плані", any(t["name"] == "Зал" for t in tasks.day_plan(monday + timedelta(days=1))["tasks"]), False)

# Одноразова зникає з наступного дня після виконання.
tasks.set_done(once, today - timedelta(days=1), True)
check("виконана одноразова зникла", any(t["name"] == "Замовити окуляри" for t in tasks.day_plan(today)["tasks"]), False)

heat = tasks.history(14)
check("теплокарта на 14 днів", len(heat["days"]), 14)

# ── Модуль 2: сон ───────────────────────────────────────────────────────────
print("\n--- Сон ---")
check("ніч після півночі належить попередній даті", sleep.night_date(datetime(2026, 3, 4, 1, 20)), date(2026, 3, 3))
check("ніч увечері належить своїй даті", sleep.night_date(datetime(2026, 3, 4, 23, 40)), date(2026, 3, 4))

night = sleep.mark_bed(datetime.combine(today - timedelta(days=1), datetime.min.time()) + timedelta(hours=23))
sleep.mark_wake(datetime.combine(today, datetime.min.time()) + timedelta(hours=7, minutes=30))
row = [n for n in sleep.nights(3) if n["date"] == (today - timedelta(days=1)).isoformat()][0]
check("тривалість порахована", row["duration"], 510)

sleep.save_night(today - timedelta(days=2), sleep_time="23:30", wake_time="06:00", quality=4)
row = [n for n in sleep.nights(4) if n["date"] == (today - timedelta(days=2)).isoformat()][0]
check("ручний ввід через HH:MM", row["duration"], 390)
check("оцінка збереглась", row["quality"], 4)

for back in range(3, 6):
    sleep.save_night(today - timedelta(days=back), sleep_time="01:00", wake_time="06:00")
advice = sleep.advisor(datetime.now())
check("помічник бачить недосип", advice["deficit"], True)
check("форматування тривалості", sleep.fmt(510), "8 год 30 хв")

# ── Модуль 3: їжа ───────────────────────────────────────────────────────────
print("\n--- Їжа ---")
png = bytes.fromhex("89504e470d0a1a0a")  # достатньо, щоб перевірити збереження файлу
name = food.save_photo(png, "image/png")
check("файл фото на місці", (TMP / "photos" / name).exists(), True)

plain_id = food.add_entry(name, moment=datetime.now() - timedelta(days=4), tag="plain")
food.add_entry(food.save_photo(png, "image/png"), moment=datetime.now() - timedelta(days=3), tag="sweet")
food.add_entry(food.save_photo(png, "image/png"), moment=datetime.now() - timedelta(days=1))
check("нетеговані рахуються", food.untagged_count(), 1)

streak = food.sweet_streak()
check("стрік без солодкого", streak["streak"], 3)

food.set_tag(plain_id, "sweet")
check("тег перезаписується", food.get_entry(plain_id)["tag"], "sweet")
check("стрік після зміни тегу", food.sweet_streak()["streak"], 3)

feed = food.feed(20)
check("стрічка згрупована по датах", len(feed), 3)
weekly = food.weekly_stats(4)
check("тижнева статистика рахує солодке", sum(w["sweets"] for w in weekly), 2)

food.delete_entry(plain_id)
check("видалення прибирає запис", food.get_entry(plain_id), None)

print("\n" + ("Усе гаразд." if ok else "Є розбіжності — дивись рядки з [!!]."))
print(f"Тимчасова база: {TMP}")
sys.exit(0 if ok else 1)
