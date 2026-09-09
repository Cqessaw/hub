-- Одна база на всі три модулі: своя таблиця на кожен, спільна таблиця налаштувань.

CREATE TABLE IF NOT EXISTS tasks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    -- 'once' | 'daily' | 'days:1,3,5'  (1 = понеділок ... 7 = неділя)
    recurrence_rule TEXT    NOT NULL DEFAULT 'once',
    note            TEXT    NOT NULL DEFAULT '',
    active          INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS task_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id   INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    date      TEXT    NOT NULL,          -- YYYY-MM-DD
    completed INTEGER NOT NULL DEFAULT 0,
    UNIQUE (task_id, date)
);

CREATE INDEX IF NOT EXISTS task_logs_by_date ON task_logs(date);

CREATE TABLE IF NOT EXISTS sleep_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL UNIQUE,     -- «ніч на» — дата, коли лягав
    sleep_time TEXT,                     -- ISO-час, коли ліг
    wake_time  TEXT,                     -- ISO-час, коли прокинувся
    duration   INTEGER,                  -- хвилин, рахується автоматично
    quality    INTEGER,                  -- 1..5, необов'язково
    note       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS food_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp      TEXT NOT NULL,        -- ISO-час знімка
    date           TEXT NOT NULL,        -- YYYY-MM-DD, для стрічки й стріків
    photo_path     TEXT,                 -- ім'я файлу в data/photos
    tag            TEXT,                 -- 'sweet' | 'plain' | NULL (ще не позначено)
    note           TEXT NOT NULL DEFAULT '',
    source         TEXT NOT NULL DEFAULT 'telegram',
    suggested_tag  TEXT,                 -- підказка від Claude, якщо ввімкнено
    suggestion_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS food_logs_by_date ON food_logs(date);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
