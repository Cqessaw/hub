/* Сховище й уся логіка трьох модулів. Дані живуть у IndexedDB прямо в браузері:
   ніякого сервера, ніякої мережі, нічого не виходить за межі пристрою. */

var Hub = (function () {
  "use strict";

  var DB_NAME = "hub";
  var DB_VERSION = 2;
  var dbPromise = null;

  var DEFAULT_SETTINGS = {
    sleepGoalMinutes: 480,   // бажана норма сну, хвилин
    bedtime: "23:00",        // орієнтовний час лягати
    warnNights: 5,           // скільки останніх ночей дивиться помічник
    notifyBedtime: false,    // системне нагадування, коли застосунок відкритий
    theme: "",               // "" = за системою
    lastBackupAt: ""         // коли востаннє зберігали копію
  };

  // ── Дати ────────────────────────────────────────────────────────────────

  function pad(n) { return String(n).padStart(2, "0"); }

  function isoOf(date) {
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  }

  function today() { return isoOf(new Date()); }

  function parseISO(iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function shift(iso, days) {
    var d = parseISO(iso);
    d.setDate(d.getDate() + days);
    return isoOf(d);
  }

  function isoWeekday(iso) {
    var d = parseISO(iso).getDay();   // 0 = неділя
    return d === 0 ? 7 : d;
  }

  function mondayOf(iso) { return shift(iso, -(isoWeekday(iso) - 1)); }

  function stamp(date) {
    return isoOf(date) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  function minutesBetween(a, b) {
    return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
  }

  // ── Обгортка над IndexedDB ──────────────────────────────────────────────

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (event) {
        var db = request.result;
        if (!db.objectStoreNames.contains("tasks")) {
          db.createObjectStore("tasks", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("taskLogs")) {
          var logs = db.createObjectStore("taskLogs", { keyPath: "key" });
          logs.createIndex("byDate", "date");
          logs.createIndex("byTask", "taskId");
        }
        if (!db.objectStoreNames.contains("sleep")) {
          db.createObjectStore("sleep", { keyPath: "date" });
        }
        if (!db.objectStoreNames.contains("food")) {
          var food = db.createObjectStore("food", { keyPath: "id", autoIncrement: true });
          food.createIndex("byDate", "date");
          food.createIndex("byTs", "ts");
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains("photos")) {
          db.createObjectStore("photos", { keyPath: "id" });
        }
        if (event.oldVersion < 2) {
          // Раніше знімок лежав в одному записі з тегами, і будь-яка зміна тегу
          // переписувала його. WebKit на такому перезаписі губить блоб — тому
          // фото переїжджають у власне сховище й далі не чіпаються.
          var upgrade = request.transaction;
          var foodStore = upgrade.objectStore("food");
          var photoStore = upgrade.objectStore("photos");
          foodStore.openCursor().onsuccess = function (cursorEvent) {
            var cursor = cursorEvent.target.result;
            if (!cursor) return;
            var value = cursor.value;
            if (value.blob) {
              photoStore.put({ id: value.id, blob: value.blob, type: value.type || "image/jpeg" });
              delete value.blob;
              cursor.update(value);
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error("База зайнята іншою вкладкою")); };
    });
    return dbPromise;
  }

  function done(transaction) {
    return new Promise(function (resolve, reject) {
      transaction.oncomplete = function () { resolve(); };
      transaction.onerror = function () { reject(transaction.error); };
      transaction.onabort = function () { reject(transaction.error); };
    });
  }

  function req(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function getAll(storeName, indexName, range) {
    return open().then(function (db) {
      var store = db.transaction(storeName, "readonly").objectStore(storeName);
      var source = indexName ? store.index(indexName) : store;
      return req(source.getAll(range || undefined));
    });
  }

  function put(storeName, value) {
    return open().then(function (db) {
      var transaction = db.transaction(storeName, "readwrite");
      var request = transaction.objectStore(storeName).put(value);
      return req(request);
    });
  }

  function remove(storeName, key) {
    return open().then(function (db) {
      var transaction = db.transaction(storeName, "readwrite");
      return req(transaction.objectStore(storeName).delete(key));
    });
  }

  // ── Налаштування ────────────────────────────────────────────────────────

  function getSettings() {
    return getAll("settings").then(function (rows) {
      var out = Object.assign({}, DEFAULT_SETTINGS);
      rows.forEach(function (row) { out[row.key] = row.value; });
      return out;
    });
  }

  function saveSettings(patch) {
    var keys = Object.keys(patch);
    return open().then(function (db) {
      var transaction = db.transaction("settings", "readwrite");
      var store = transaction.objectStore("settings");
      keys.forEach(function (key) { store.put({ key: key, value: patch[key] }); });
      return done(transaction);
    }).then(getSettings);
  }

  // ── Модуль 1: задачі ────────────────────────────────────────────────────

  var ONCE = "once";
  var DAILY = "daily";
  var DOW_SHORT = { 1: "Пн", 2: "Вт", 3: "Ср", 4: "Чт", 5: "Пт", 6: "Сб", 7: "Нд" };

  function normalizeRule(rule) {
    var raw = String(rule == null ? ONCE : rule).trim().toLowerCase();
    if (raw === "" || raw === ONCE) return ONCE;
    if (raw === DAILY) return DAILY;
    if (raw.indexOf("days:") === 0) {
      var days = raw.slice(5).split(",")
        .map(function (part) { return parseInt(part, 10); })
        .filter(function (n) { return n >= 1 && n <= 7; });
      days = Array.from(new Set(days)).sort(function (a, b) { return a - b; });
      if (!days.length || days.length === 7) return DAILY;
      return "days:" + days.join(",");
    }
    throw new Error("Невідоме правило повторення: " + rule);
  }

  function ruleDays(rule) {
    if (rule === DAILY) return [1, 2, 3, 4, 5, 6, 7];
    if (rule.indexOf("days:") === 0) {
      return rule.slice(5).split(",").map(Number);
    }
    return [];
  }

  function isRecurring(rule) { return rule !== ONCE; }

  function isDue(rule, iso) {
    if (rule === ONCE) return true;
    return ruleDays(rule).indexOf(isoWeekday(iso)) !== -1;
  }

  function describeRule(rule) {
    if (rule === ONCE) return "одноразова";
    if (rule === DAILY) return "щодня";
    return ruleDays(rule).map(function (d) { return DOW_SHORT[d]; }).join("/");
  }

  function logKey(taskId, date) { return taskId + "|" + date; }

  function createTask(name, rule, note) {
    var clean = String(name || "").trim();
    if (!clean) throw new Error("Назва задачі не може бути порожньою");
    var normalized = normalizeRule(rule);
    return getAll("tasks").then(function (tasks) {
      var order = tasks.reduce(function (max, t) { return Math.max(max, t.order || 0); }, 0) + 1;
      return put("tasks", {
        name: clean,
        rule: normalized,
        note: String(note || "").trim(),
        active: true,
        order: order,
        createdAt: stamp(new Date())
      });
    });
  }

  function updateTask(id, patch) {
    return open().then(function (db) {
      var transaction = db.transaction("tasks", "readwrite");
      var store = transaction.objectStore("tasks");
      return req(store.get(id)).then(function (task) {
        if (!task) throw new Error("Такої задачі немає");
        if (patch.name !== undefined) {
          var name = String(patch.name).trim();
          if (!name) throw new Error("Назва задачі не може бути порожньою");
          task.name = name;
        }
        if (patch.rule !== undefined) task.rule = normalizeRule(patch.rule);
        if (patch.note !== undefined) task.note = String(patch.note).trim();
        if (patch.active !== undefined) task.active = !!patch.active;
        if (patch.order !== undefined) task.order = patch.order;
        return req(store.put(task));
      });
    });
  }

  function deleteTask(id) {
    return getAll("taskLogs", "byTask", IDBKeyRange.only(id)).then(function (logs) {
      return open().then(function (db) {
        var transaction = db.transaction(["tasks", "taskLogs"], "readwrite");
        logs.forEach(function (log) { transaction.objectStore("taskLogs").delete(log.key); });
        transaction.objectStore("tasks").delete(id);
        return done(transaction);
      });
    });
  }

  function moveTask(id, direction) {
    return getAll("tasks").then(function (tasks) {
      var list = tasks.filter(function (t) { return t.active; }).sort(byOrder);
      var index = list.findIndex(function (t) { return t.id === id; });
      var swapWith = index + direction;
      if (index === -1 || swapWith < 0 || swapWith >= list.length) return null;
      var a = list[index], b = list[swapWith];
      var tmp = a.order;
      a.order = b.order;
      b.order = tmp;
      return open().then(function (db) {
        var transaction = db.transaction("tasks", "readwrite");
        transaction.objectStore("tasks").put(a);
        transaction.objectStore("tasks").put(b);
        return done(transaction);
      });
    });
  }

  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0) || a.id - b.id;
  }

  function setDone(taskId, date, completed) {
    return put("taskLogs", {
      key: logKey(taskId, date),
      taskId: taskId,
      date: date,
      completed: !!completed
    });
  }

  function streakOf(rule, doneDates, day) {
    if (!isRecurring(rule) || !doneDates.length) return 0;
    // Далі за найранішу відмітку стрік тягнутись не може, тож там і зупиняємось.
    var floor = doneDates[0];
    var done = new Set(doneDates);
    var cursor = day;
    if (isDue(rule, cursor) && !done.has(cursor)) cursor = shift(cursor, -1);
    var count = 0;
    while (cursor >= floor && count < 3650) {
      if (isDue(rule, cursor)) {
        if (done.has(cursor)) count += 1;
        else break;
      }
      cursor = shift(cursor, -1);
    }
    return count;
  }

  function taskContext() {
    return Promise.all([getAll("tasks"), getAll("taskLogs")]).then(function (parts) {
      var tasks = parts[0].sort(byOrder);
      var doneByTask = {};
      var doneByDate = {};
      parts[1].forEach(function (log) {
        if (!log.completed) return;
        (doneByTask[log.taskId] = doneByTask[log.taskId] || []).push(log.date);
        (doneByDate[log.date] = doneByDate[log.date] || []).push(log.taskId);
      });
      Object.keys(doneByTask).forEach(function (id) { doneByTask[id].sort(); });
      return { tasks: tasks, doneByTask: doneByTask, doneByDate: doneByDate };
    });
  }

  function decorate(task, ctx, day) {
    var dates = ctx.doneByTask[task.id] || [];
    return {
      id: task.id,
      name: task.name,
      rule: task.rule,
      note: task.note || "",
      active: task.active !== false,
      order: task.order || 0,
      createdAt: task.createdAt,
      due: isDue(task.rule, day),
      completed: dates.indexOf(day) !== -1,
      recurring: isRecurring(task.rule),
      ruleLabel: describeRule(task.rule),
      streak: streakOf(task.rule, dates, day),
      firstDone: dates.length ? dates[0] : null
    };
  }

  function listTasks(day, includeArchived) {
    var when = day || today();
    return taskContext().then(function (ctx) {
      return ctx.tasks
        .filter(function (t) { return includeArchived || t.active !== false; })
        .map(function (t) { return decorate(t, ctx, when); });
    });
  }

  function dayPlan(day) {
    var when = day || today();
    return taskContext().then(function (ctx) {
      var items = ctx.tasks
        .filter(function (t) { return t.active !== false; })
        .map(function (t) { return decorate(t, ctx, when); })
        .filter(function (t) { return t.due; })
        // Одноразова зникає з плану наступного дня після того, як її виконали.
        .filter(function (t) {
          if (t.recurring) return true;
          var dates = ctx.doneByTask[t.id] || [];
          return !dates.some(function (d) { return d < when; });
        });
      return {
        date: when,
        tasks: items,
        done: items.filter(function (t) { return t.completed; }).length,
        total: items.length
      };
    });
  }

  function activeStreaks(day) {
    return listTasks(day).then(function (tasks) {
      return tasks
        .filter(function (t) { return t.recurring; })
        .sort(function (a, b) { return b.streak - a.streak || a.name.localeCompare(b.name, "uk"); });
    });
  }

  function history(days, end, taskId) {
    var last = end || today();
    var first = shift(last, -(days - 1));
    return taskContext().then(function (ctx) {
      var only = taskId ? ctx.tasks.filter(function (t) { return t.id === taskId; }) : null;
      var starts = {};
      ctx.tasks.forEach(function (task) {
        var created = String(task.createdAt || last).slice(0, 10);
        var dates = ctx.doneByTask[task.id] || [];
        starts[task.id] = dates.length && dates[0] < created ? dates[0] : created;
      });

      var out = [];
      var cursor = first;
      while (cursor <= last) {
        var doneIds = ctx.doneByDate[cursor] || [];
        var pool = only || ctx.tasks;
        if (only) doneIds = doneIds.filter(function (id) { return id === taskId; });
        var planned = pool.filter(function (task) {
          return isRecurring(task.rule) && isDue(task.rule, cursor) && starts[task.id] <= cursor;
        });
        var plannedIds = planned.map(function (t) { return t.id; });
        var done = plannedIds.filter(function (id) { return doneIds.indexOf(id) !== -1; }).length;
        var extra = doneIds.filter(function (id) { return plannedIds.indexOf(id) === -1; }).length;
        out.push({
          date: cursor,
          planned: planned.length,
          done: done,
          extra: extra,
          ratio: planned.length ? done / planned.length : (extra ? 1 : null)
        });
        cursor = shift(cursor, 1);
      }
      return { from: first, to: last, days: out };
    });
  }

  function perfectStreak(end) {
    // День вважається ідеальним, коли виконано весь план на нього.
    // Дні без плану пропускаємо — вони ні рвуть стрік, ні додають до нього.
    var last = end || today();
    return taskContext().then(function (ctx) {
      var starts = {};
      ctx.tasks.forEach(function (task) {
        var created = String(task.createdAt || last).slice(0, 10);
        var dates = ctx.doneByTask[task.id] || [];
        starts[task.id] = dates.length && dates[0] < created ? dates[0] : created;
      });

      var allDates = Object.keys(ctx.doneByDate).sort();
      if (!allDates.length) return { streak: 0, best: 0 };
      var floor = allDates[0];

      function dayState(iso) {
        var planned = ctx.tasks.filter(function (task) {
          return task.active !== false && isRecurring(task.rule) &&
            isDue(task.rule, iso) && starts[task.id] <= iso;
        });
        if (!planned.length) return null;            // плану не було
        var done = ctx.doneByDate[iso] || [];
        return planned.every(function (task) { return done.indexOf(task.id) !== -1; });
      }

      var cursor = last;
      if (dayState(cursor) === false) cursor = shift(cursor, -1);   // сьогодні ще попереду
      var streak = 0;
      while (cursor >= floor && streak < 3650) {
        var state = dayState(cursor);
        if (state === false) break;
        if (state === true) streak += 1;
        cursor = shift(cursor, -1);
      }

      var best = 0, current = 0;
      var walk = floor;
      while (walk <= last) {
        var value = dayState(walk);
        if (value === false) current = 0;
        else if (value === true) { current += 1; best = Math.max(best, current); }
        walk = shift(walk, 1);
      }

      return { streak: streak, best: Math.max(best, streak) };
    });
  }

  function logByDates(days, end, taskId) {
    var last = end || today();
    var first = shift(last, -(days - 1));
    return taskContext().then(function (ctx) {
      var names = {};
      ctx.tasks.forEach(function (t) { names[t.id] = t.name; });
      return Object.keys(ctx.doneByDate)
        .filter(function (date) { return date >= first && date <= last; })
        .sort().reverse()
        .map(function (date) {
          var ids = ctx.doneByDate[date];
          if (taskId) ids = ids.filter(function (id) { return id === taskId; });
          return { date: date, names: ids.map(function (id) { return names[id]; }).filter(Boolean) };
        })
        .filter(function (day) { return day.names.length; });
    });
  }

  function bestStreakOf(rule, doneDates) {
    if (!doneDates.length) return 0;
    var done = new Set(doneDates);
    var best = 0, current = 0;
    var cursor = doneDates[0];
    var last = doneDates[doneDates.length - 1];
    while (cursor <= last) {
      if (isDue(rule, cursor)) {
        if (done.has(cursor)) { current += 1; best = Math.max(best, current); }
        else current = 0;
      }
      cursor = shift(cursor, 1);
    }
    return best;
  }

  function taskStats(taskId, days, end) {
    // Скільки разів задачу зроблено за період і як часто це виходить.
    var last = end || today();
    var first = shift(last, -(days - 1));
    return taskContext().then(function (ctx) {
      var task = ctx.tasks.find(function (t) { return t.id === taskId; });
      if (!task) return null;
      var dates = ctx.doneByTask[task.id] || [];
      var inRange = dates.filter(function (d) { return d >= first && d <= last; });
      var start = dates.length && dates[0] < String(task.createdAt || last).slice(0, 10)
        ? dates[0] : String(task.createdAt || last).slice(0, 10);

      var planned = 0;
      var cursor = first;
      while (cursor <= last) {
        if (isRecurring(task.rule) && isDue(task.rule, cursor) && start <= cursor) planned += 1;
        cursor = shift(cursor, 1);
      }

      return {
        id: task.id,
        name: task.name,
        rule: task.rule,
        ruleLabel: describeRule(task.rule),
        recurring: isRecurring(task.rule),
        done: inRange.length,
        planned: planned,
        ratio: planned ? inRange.length / planned : null,
        perWeek: Math.round((inRange.length / days) * 7 * 10) / 10,
        streak: streakOf(task.rule, dates, last),
        best: bestStreakOf(task.rule, dates),
        total: dates.length,
        firstDone: dates.length ? dates[0] : null
      };
    });
  }

  // ── Модуль 2: сон ───────────────────────────────────────────────────────

  function nightDateOf(date) {
    // Ліг о 23:40 — це ніч поточної дати. Ліг о 01:20 — ще попередня ніч.
    return date.getHours() >= 12 ? isoOf(date) : shift(isoOf(date), -1);
  }

  function combine(night, hhmm, kind) {
    var parts = hhmm.split(":").map(Number);
    var hour = parts[0], minute = parts[1] || 0;
    var day;
    if (kind === "sleep") day = hour >= 12 ? night : shift(night, 1);
    else day = hour >= 18 ? night : shift(night, 1);
    return day + "T" + pad(hour) + ":" + pad(minute);
  }

  function durationOf(sleepTime, wakeTime) {
    if (!sleepTime || !wakeTime) return null;
    var minutes = minutesBetween(sleepTime, wakeTime);
    if (minutes <= 0 || minutes > 24 * 60) return null;
    return minutes;
  }

  function saveNight(night, patch) {
    return open().then(function (db) {
      var transaction = db.transaction("sleep", "readwrite");
      var store = transaction.objectStore("sleep");
      return req(store.get(night)).then(function (row) {
        var entry = row || {
          date: night, sleepTime: null, wakeTime: null,
          duration: null, quality: null, note: "", naps: []
        };
        if (!Array.isArray(entry.naps)) entry.naps = [];
        if (patch.sleepTime !== undefined) {
          entry.sleepTime = patch.sleepTime && patch.sleepTime.length <= 5
            ? combine(night, patch.sleepTime, "sleep") : (patch.sleepTime || null);
        }
        if (patch.wakeTime !== undefined) {
          entry.wakeTime = patch.wakeTime && patch.wakeTime.length <= 5
            ? combine(night, patch.wakeTime, "wake") : (patch.wakeTime || null);
        }
        if (patch.quality !== undefined) {
          entry.quality = patch.quality ? Math.max(1, Math.min(5, Number(patch.quality))) : null;
        }
        if (patch.note !== undefined) entry.note = String(patch.note).trim();
        entry.duration = durationOf(entry.sleepTime, entry.wakeTime);
        return req(store.put(entry)).then(function () { return entry; });
      });
    });
  }

  function markBed(now) {
    var moment = now || new Date();
    return saveNight(nightDateOf(moment), { sleepTime: stamp(moment) });
  }

  function markWake(now) {
    var moment = now || new Date();
    var mark = stamp(moment);
    return getAll("sleep").then(function (rows) {
      var open_ = rows
        .filter(function (r) { return r.sleepTime && !r.wakeTime; })
        .sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
      if (open_ && durationOf(open_.sleepTime, mark) !== null) {
        return saveNight(open_.date, { wakeTime: mark });
      }
      // Немає відкритої ночі (або вона надто давня) — заводимо запис самі.
      var night = moment.getHours() < 18 ? shift(isoOf(moment), -1) : isoOf(moment);
      return saveNight(night, { wakeTime: mark });
    });
  }

  function deleteNight(night) { return remove("sleep", night); }

  // ── Дрімання серед дня ──────────────────────────────────────────────────

  function napMinutes(nap) {
    if (!nap || !nap.start || !nap.end) return null;
    var a = nap.start.split(":").map(Number);
    var b = nap.end.split(":").map(Number);
    var minutes = (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]);
    if (minutes <= 0) minutes += 24 * 60;      // задрімав під північ
    return minutes > 12 * 60 ? null : minutes;
  }

  function napsOf(entry) {
    return Array.isArray(entry && entry.naps) ? entry.naps : [];
  }

  function napTotal(entry) {
    return napsOf(entry).reduce(function (sum, nap) { return sum + (napMinutes(nap) || 0); }, 0);
  }

  function withNaps(date, change) {
    return open().then(function (db) {
      var transaction = db.transaction("sleep", "readwrite");
      var store = transaction.objectStore("sleep");
      return req(store.get(date)).then(function (row) {
        var entry = row || {
          date: date, sleepTime: null, wakeTime: null,
          duration: null, quality: null, note: "", naps: []
        };
        if (!Array.isArray(entry.naps)) entry.naps = [];
        change(entry.naps);
        entry.naps.forEach(function (nap) { nap.duration = napMinutes(nap); });
        entry.naps.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
        return req(store.put(entry)).then(function () { return entry; });
      });
    });
  }

  function addNap(date, start, end, note) {
    if (!start) throw new Error("Вкажи, коли задрімав");
    return withNaps(date, function (naps) {
      naps.push({ start: start, end: end || "", note: String(note || "").trim() });
    });
  }

  function saveNap(date, index, patch) {
    return withNaps(date, function (naps) {
      var nap = naps[index];
      if (!nap) throw new Error("Такого дрімання немає");
      if (patch.start !== undefined) nap.start = patch.start || "";
      if (patch.end !== undefined) nap.end = patch.end || "";
      if (patch.note !== undefined) nap.note = String(patch.note).trim();
    });
  }

  function deleteNap(date, index) {
    return withNaps(date, function (naps) { naps.splice(index, 1); });
  }

  function clearNight(date) {
    // Прибираємо години сну; дрімання цього дня лишаються.
    return saveNight(date, { sleepTime: "", wakeTime: "", quality: 0 }).then(function (entry) {
      if (!napsOf(entry).length) return remove("sleep", date).then(function () { return null; });
      return entry;
    });
  }

  function nights(days, end) {
    var last = end || today();
    var first = shift(last, -(days - 1));
    return getAll("sleep").then(function (rows) {
      var byDate = {};
      rows.forEach(function (row) { byDate[row.date] = row; });
      var out = [];
      var cursor = first;
      while (cursor <= last) {
        var row = byDate[cursor] || {
          date: cursor, sleepTime: null, wakeTime: null,
          duration: null, quality: null, note: "", naps: []
        };
        row.naps = napsOf(row);
        row.napMinutes = napTotal(row);
        row.total = (row.duration || 0) + row.napMinutes;
        out.push(row);
        cursor = shift(cursor, 1);
      }
      return out;
    });
  }

  function statsOf(rows) {
    var filled = rows.filter(function (r) { return r.duration; });
    var napSum = rows.reduce(function (sum, r) { return sum + (r.napMinutes || 0); }, 0);
    var napDays = rows.filter(function (r) { return r.napMinutes; }).length;
    if (!filled.length) {
      return {
        nights: 0, avg: null, min: null, max: null, avgQuality: null,
        napMinutes: napSum, napDays: napDays, avgTotal: null
      };
    }
    var durations = filled.map(function (r) { return r.duration; });
    var qualities = filled.filter(function (r) { return r.quality; }).map(function (r) { return r.quality; });
    return {
      nights: filled.length,
      avg: Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length),
      min: Math.min.apply(null, durations),
      max: Math.max.apply(null, durations),
      avgQuality: qualities.length
        ? Math.round((qualities.reduce(function (a, b) { return a + b; }, 0) / qualities.length) * 10) / 10
        : null,
      napMinutes: napSum,
      napDays: napDays,
      avgTotal: Math.round((durations.reduce(function (a, b) { return a + b; }, 0) + napSum) / filled.length)
    };
  }

  function sleepStats(days, end) {
    return nights(days, end).then(statsOf);
  }

  function weeklyAverage(weeks, end) {
    var last = end || today();
    return nights(weeks * 7, last).then(function (rows) {
      var buckets = {};
      rows.forEach(function (row) {
        if (!row.duration) return;
        var week = mondayOf(row.date);
        (buckets[week] = buckets[week] || []).push(row.duration);
      });
      return Object.keys(buckets).sort().map(function (week) {
        var values = buckets[week];
        return {
          week: week,
          avg: Math.round(values.reduce(function (a, b) { return a + b; }, 0) / values.length),
          nights: values.length
        };
      });
    });
  }

  function advisor(now) {
    var moment = now || new Date();
    return getSettings().then(function (settings) {
      var goal = Math.max(60, Number(settings.sleepGoalMinutes) || 480);
      var bedtime = /^\d{1,2}:\d{2}$/.test(settings.bedtime || "") ? settings.bedtime : "23:00";
      var window_ = Math.max(2, Number(settings.warnNights) || 5);
      return Promise.all([nights(window_, isoOf(moment)), nights(1, nightDateOf(moment))])
        .then(function (parts) {
          var recent = parts[0].filter(function (r) { return r.duration; });
          var tonightRow = parts[1][0];
          var avg = recent.length
            ? Math.round(recent.reduce(function (a, r) { return a + r.duration; }, 0) / recent.length)
            : null;
          var deficit = recent.length >= 3 && avg !== null && avg < goal - 20;

          var hm = bedtime.split(":").map(Number);
          var bed = new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), hm[0], hm[1]);
          if (moment.getTime() > bed.getTime() + 6 * 3600 * 1000) bed.setDate(bed.getDate() + 1);
          var minutesToBed = Math.floor((bed.getTime() - moment.getTime()) / 60000);

          var messages = [];
          if (minutesToBed >= 0 && minutesToBed <= 45) {
            messages.push("До орієнтовного відбою о " + bedtime + " лишилось " + minutesToBed + " хв.");
          } else if (minutesToBed < 0) {
            messages.push("Час відбою о " + bedtime + " вже минув " + (-minutesToBed) + " хв тому.");
          }
          if (deficit) {
            messages.push("Останні " + recent.length + " ночей у середньому " + fmtMinutes(avg) +
              " — це менше за норму " + fmtMinutes(goal) + ".");
          }

          return {
            goalMinutes: goal,
            bedtime: bedtime,
            minutesToBed: minutesToBed,
            bedDue: minutesToBed <= 45,
            avgRecent: avg,
            recentNights: recent.length,
            deficit: deficit,
            tonight: tonightRow && tonightRow.sleepTime ? tonightRow : null,
            messages: messages
          };
        });
    });
  }

  function fmtMinutes(minutes) {
    if (!minutes) return "—";
    return Math.floor(minutes / 60) + " год " + pad(minutes % 60) + " хв";
  }

  // ── Модуль 3: їжа ───────────────────────────────────────────────────────

  var MAX_SIDE = 1280;

  // Категорії їжі задає користувач. «Звичайне» — основа, решту можна додавати
  // й прибирати; avoid означає «те, чого уникаю» — саме воно рве стрік.
  var DEFAULT_FOOD_TAGS = [
    { id: "plain",   name: "Звичайне", emoji: "🥗", avoid: false },
    { id: "sweet",   name: "Солодке",  emoji: "🍰", avoid: true  },
    { id: "protein", name: "Білкове",  emoji: "🍗", avoid: false },
    { id: "fast",    name: "Фастфуд",  emoji: "🍟", avoid: true  },
    { id: "ideal",   name: "Ідеально", emoji: "✅", avoid: false }
  ];

  function getFoodTags() {
    return getSettings().then(function (settings) {
      var list = settings.foodTags;
      if (!Array.isArray(list) || !list.length) {
        return DEFAULT_FOOD_TAGS.map(function (t) { return Object.assign({}, t); });
      }
      return list.map(function (t) {
        return { id: t.id, name: t.name, emoji: t.emoji || "🍽", avoid: !!t.avoid };
      });
    });
  }

  function saveFoodTags(list) {
    return saveSettings({ foodTags: list }).then(function () { return list; });
  }

  function addFoodTag(name, emoji, avoid) {
    var clean = String(name || "").trim();
    if (!clean) throw new Error("Назва категорії не може бути порожньою");
    return getFoodTags().then(function (list) {
      if (list.some(function (t) { return t.name.toLowerCase() === clean.toLowerCase(); })) {
        throw new Error("Така категорія вже є");
      }
      list.push({
        id: "t" + Date.now().toString(36),
        name: clean.slice(0, 24),
        emoji: String(emoji || "").trim().slice(0, 4) || "🍽",
        avoid: !!avoid
      });
      return saveFoodTags(list);
    });
  }

  function updateFoodTag(id, patch) {
    return getFoodTags().then(function (list) {
      var tag = list.find(function (t) { return t.id === id; });
      if (!tag) throw new Error("Категорії немає");
      if (patch.name !== undefined) {
        var clean = String(patch.name).trim();
        if (!clean) throw new Error("Назва категорії не може бути порожньою");
        tag.name = clean.slice(0, 24);
      }
      if (patch.emoji !== undefined) tag.emoji = String(patch.emoji).trim().slice(0, 4) || "🍽";
      if (patch.avoid !== undefined) tag.avoid = !!patch.avoid;
      return saveFoodTags(list);
    });
  }

  function deleteFoodTag(id) {
    // Прибираємо категорію і водночас знімаємо її з усіх знімків.
    return getFoodTags().then(function (list) {
      var rest = list.filter(function (t) { return t.id !== id; });
      if (!rest.length) throw new Error("Хоч одна категорія має лишитись");
      return saveFoodTags(rest);
    }).then(foodRows).then(function (rows) {
      return rows.filter(function (row) { return tagsOf(row).indexOf(id) !== -1; })
        .reduce(function (chain, row) {
          return chain.then(function () {
            return setTags(row.id, tagsOf(row).filter(function (t) { return t !== id; }));
          });
        }, Promise.resolve());
    });
  }

  function tagsOf(entry) {
    if (Array.isArray(entry.tags)) return entry.tags;
    return entry.tag ? [entry.tag] : [];
  }

  function shrink(file) {
    // Фото з камери — це кілька мегабайтів. Зменшуємо, щоб сховище не роздувалось.
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        var scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
        var width = Math.round(image.width * scale);
        var height = Math.round(image.height * scale);
        var canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(image, 0, 0, width, height);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          // Свій blob, а не файл із камери: файл лежить у тимчасовій теці системи,
          // і телефон має право прибрати її будь-коли.
          resolve(blob || file);
        }, "image/jpeg", 0.82);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);   // не вдалось перемалювати — збережемо як є
      };
      image.src = url;
    });
  }

  function addPhoto(file, options) {
    var opts = options || {};
    return shrink(file).then(function (blob) {
      var moment = opts.moment || new Date();
      var tags = Array.isArray(opts.tags) ? opts.tags : (opts.tag ? [opts.tag] : []);
      return storeEntry({
        ts: stamp(moment),
        date: isoOf(moment),
        type: blob.type || "image/jpeg",
        tags: tags,
        tag: mirrorTag(tags),
        note: String(opts.note || "").trim(),
        source: opts.source || "camera"
      }, blob);
    });
  }

  function storeEntry(record, blob) {
    // Опис і саме фото пишемо однією транзакцією, але в різні сховища.
    return open().then(function (db) {
      var transaction = db.transaction(["food", "photos"], "readwrite");
      var foodStore = transaction.objectStore("food");
      var photoStore = transaction.objectStore("photos");
      var newId = null;
      return req(foodStore.put(record)).then(function (id) {
        newId = id;
        if (blob) photoStore.put({ id: id, blob: blob, type: blob.type || "image/jpeg" });
        return done(transaction);
      }).then(function () { return newId; });
    });
  }

  function mirrorTag(tags) {
    // Старі копії й Python-хаб знають лише одне поле — лишаємо його осмисленим.
    if (!tags.length) return null;
    return tags.indexOf("sweet") !== -1 ? "sweet" : tags[0];
  }

  function setTags(id, tags) {
    return open().then(function (db) {
      var transaction = db.transaction("food", "readwrite");
      var store = transaction.objectStore("food");
      return req(store.get(id)).then(function (entry) {
        if (!entry) throw new Error("Запису немає");
        entry.tags = tags.slice();
        entry.tag = mirrorTag(entry.tags);
        return req(store.put(entry)).then(function () { return entry; });
      });
    });
  }

  function toggleTag(id, tagId) {
    return open().then(function (db) {
      var transaction = db.transaction("food", "readwrite");
      var store = transaction.objectStore("food");
      return req(store.get(id)).then(function (entry) {
        if (!entry) throw new Error("Запису немає");
        var tags = tagsOf(entry).slice();
        var at = tags.indexOf(tagId);
        if (at === -1) tags.push(tagId); else tags.splice(at, 1);
        entry.tags = tags;
        entry.tag = mirrorTag(tags);
        return req(store.put(entry)).then(function () { return entry; });
      });
    });
  }

  function updateFood(id, patch) {
    return open().then(function (db) {
      var transaction = db.transaction("food", "readwrite");
      var store = transaction.objectStore("food");
      return req(store.get(id)).then(function (entry) {
        if (!entry) throw new Error("Запису немає");
        if (patch.tags !== undefined) {
          entry.tags = patch.tags.slice();
          entry.tag = mirrorTag(entry.tags);
        }
        if (patch.note !== undefined) entry.note = String(patch.note).trim();
        return req(store.put(entry)).then(function () { return entry; });
      });
    });
  }

  function deleteFood(id) {
    return open().then(function (db) {
      var transaction = db.transaction(["food", "photos"], "readwrite");
      transaction.objectStore("food").delete(id);
      transaction.objectStore("photos").delete(id);
      return done(transaction);
    });
  }

  function foodRows() {
    // Тільки опис знімків: теги, дати, нотатки. Самі фото — окремо й на вимогу.
    return getAll("food").then(function (rows) {
      return rows.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id; });
    });
  }

  function attachPhotos(rows) {
    if (!rows.length) return Promise.resolve(rows);
    return open().then(function (db) {
      var store = db.transaction("photos", "readonly").objectStore("photos");
      return Promise.all(rows.map(function (row) {
        if (row.blob) return row;                 // запис ще старого зразка
        return req(store.get(row.id)).then(function (photo) {
          if (photo) {
            row.blob = photo.blob;
            row.type = photo.type || row.type;
          }
          return row;
        });
      }));
    });
  }

  function getPhoto(id) {
    return open().then(function (db) {
      var store = db.transaction("photos", "readonly").objectStore("photos");
      return req(store.get(id));
    }).then(function (photo) { return photo ? photo.blob : null; });
  }

  function avoidSet(tags) {
    return new Set(tags.filter(function (t) { return t.avoid; }).map(function (t) { return t.id; }));
  }

  function hasAvoid(entry, avoid) {
    return tagsOf(entry).some(function (id) { return avoid.has(id); });
  }

  function feed(limit) {
    return Promise.all([foodRows(), getFoodTags()]).then(function (parts) {
      var rows = parts[0];
      var avoid = avoidSet(parts[1]);
      var slice = rows.slice(0, limit || 120);
      return attachPhotos(slice).then(function (withPhotos) {
      var groups = [];
      var index = {};
      withPhotos.forEach(function (item) {
        item.tags = tagsOf(item);
        if (index[item.date] === undefined) {
          index[item.date] = groups.length;
          groups.push({ date: item.date, items: [], avoid: 0 });
        }
        var group = groups[index[item.date]];
        group.items.push(item);
        if (hasAvoid(item, avoid)) group.avoid += 1;
      });
      return groups;
      });
    });
  }

  function latestFood(limit) {
    return foodRows().then(function (rows) {
      return attachPhotos(rows.slice(0, limit || 6));
    });
  }

  function avoidStreak(end) {
    var last = end || today();
    return Promise.all([foodRows(), getFoodTags()]).then(function (parts) {
      var rows = parts[0];
      var tags = parts[1];
      var avoid = avoidSet(tags);
      var avoidTags = tags.filter(function (t) { return t.avoid; });
      var base = {
        streak: 0, last: null, best: 0, untagged: 0,
        avoidNames: avoidTags.map(function (t) { return t.emoji + " " + t.name; }),
        onlySweet: avoidTags.length === 1 && avoidTags[0].id === "sweet"
      };
      if (!rows.length || !avoid.size) return base;

      var badDays = new Set(rows.filter(function (r) { return hasAvoid(r, avoid); })
        .map(function (r) { return r.date; }));
      var floor = rows[rows.length - 1].date;

      var count = 0;
      var cursor = last;
      while (cursor >= floor && count < 366) {
        if (badDays.has(cursor)) break;
        count += 1;
        cursor = shift(cursor, -1);
      }

      var best = 0, current = 0;
      var walk = floor;
      while (walk <= last) {
        if (badDays.has(walk)) current = 0;
        else { current += 1; best = Math.max(best, current); }
        walk = shift(walk, 1);
      }

      var sorted = Array.from(badDays).sort();
      base.streak = count;
      base.best = best;
      base.last = sorted.length ? sorted[sorted.length - 1] : null;
      base.untagged = rows.filter(function (r) { return !tagsOf(r).length; }).length;
      return base;
    });
  }

  function weeklyStats(weeks, end) {
    var last = end || today();
    var first = mondayOf(shift(last, -(weeks * 7 - 1)));
    return Promise.all([foodRows(), getFoodTags()]).then(function (parts) {
      var rows = parts[0];
      var avoid = avoidSet(parts[1]);
      var buckets = {};
      var cursor = first;
      while (cursor <= last) {
        buckets[cursor] = { week: cursor, avoid: 0, total: 0, avoidDays: 0 };
        cursor = shift(cursor, 7);
      }
      var badDates = {};
      rows.forEach(function (row) {
        if (row.date < first || row.date > last) return;
        var week = mondayOf(row.date);
        var bucket = buckets[week] || (buckets[week] = { week: week, avoid: 0, total: 0, avoidDays: 0 });
        bucket.total += 1;
        if (hasAvoid(row, avoid)) {
          bucket.avoid += 1;
          (badDates[week] = badDates[week] || new Set()).add(row.date);
        }
      });
      Object.keys(badDates).forEach(function (week) { buckets[week].avoidDays = badDates[week].size; });
      return Object.keys(buckets).sort().map(function (week) { return buckets[week]; });
    });
  }

  function foodStats(days, end) {
    // Ряд по днях плюс підсумки за період — з цього малюються плитки й графік.
    var last = end || today();
    var first = shift(last, -(days - 1));
    return Promise.all([foodRows(), getFoodTags()]).then(function (parts) {
      var tags = parts[1];
      var avoid = avoidSet(tags);
      var rows = parts[0].filter(function (r) { return r.date >= first && r.date <= last; });

      var byDate = {};
      var cursor = first;
      while (cursor <= last) {
        byDate[cursor] = { date: cursor, photos: 0, avoid: 0 };
        cursor = shift(cursor, 1);
      }
      rows.forEach(function (row) {
        var day = byDate[row.date];
        if (!day) return;
        day.photos += 1;
        if (hasAvoid(row, avoid)) day.avoid += 1;
      });

      var series = Object.keys(byDate).sort().map(function (key) { return byDate[key]; });
      var avoidDays = series.filter(function (day) { return day.avoid; }).length;

      return {
        from: first,
        to: last,
        days: series,
        totalDays: series.length,
        photos: rows.length,
        avoid: rows.filter(function (row) { return hasAvoid(row, avoid); }).length,
        avoidDays: avoidDays,
        cleanDays: series.length - avoidDays,
        loggedDays: series.filter(function (day) { return day.photos; }).length,
        byTag: tags.map(function (tag) {
          var hits = rows.filter(function (row) { return tagsOf(row).indexOf(tag.id) !== -1; });
          return {
            id: tag.id, name: tag.name, emoji: tag.emoji, avoid: tag.avoid,
            count: hits.length,
            days: new Set(hits.map(function (row) { return row.date; })).size
          };
        })
      };
    });
  }

  function thisWeek(end) {
    var last = end || today();
    var monday = mondayOf(last);
    return Promise.all([foodRows(), getFoodTags()]).then(function (parts) {
      var rows = parts[0];
      var tags = parts[1];
      var avoid = avoidSet(tags);
      var inWeek = rows.filter(function (r) { return r.date >= monday && r.date <= last; });
      var bad = inWeek.filter(function (r) { return hasAvoid(r, avoid); });
      var byTag = tags.map(function (tag) {
        var hits = inWeek.filter(function (r) { return tagsOf(r).indexOf(tag.id) !== -1; });
        return {
          id: tag.id, name: tag.name, emoji: tag.emoji, avoid: tag.avoid,
          count: hits.length,
          days: new Set(hits.map(function (r) { return r.date; })).size
        };
      });
      return {
        from: monday,
        photos: inWeek.length,
        avoid: bad.length,
        avoidDays: new Set(bad.map(function (r) { return r.date; })).size,
        byTag: byTag
      };
    });
  }

  // ── Резервна копія ──────────────────────────────────────────────────────

  function blobToDataUrl(blob) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(",");
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || "image/jpeg";
    var binary = atob(parts[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function exportAll(photoMode) {
    // photoMode: "all" — усі фото, "none" — жодного, число — фото за стільки місяців.
    var mode = photoMode === true ? "all" : (photoMode === false ? "none" : (photoMode || "all"));
    var since = typeof mode === "number" ? shift(today(), -Math.round(mode * 30)) : null;
    return Promise.all([
      getAll("tasks"), getAll("taskLogs"), getAll("sleep"), foodRows(), getSettings()
    ]).then(function (parts) {
      var food = parts[3];
      var wanted = function (item) {
        if (mode === "none") return false;
        if (since) return item.date >= since;
        return true;
      };
      var photos = mode === "none"
        ? Promise.resolve(food.map(function () { return null; }))
        : attachPhotos(food.filter(wanted)).then(function () {
            return Promise.all(food.map(function (item) {
              return item.blob && wanted(item) ? blobToDataUrl(item.blob) : Promise.resolve(null);
            }));
          });
      return photos.then(function (urls) {
        return {
          app: "hub",
          version: 1,
          exportedAt: new Date().toISOString(),
          withPhotos: mode !== "none",
          photoMode: mode,
          tasks: parts[0],
          taskLogs: parts[1],
          sleep: parts[2],
          food: food.map(function (item, index) {
            return {
              ts: item.ts, date: item.date,
              tags: tagsOf(item), tag: item.tag || null,
              note: item.note || "", source: item.source || "",
              type: item.type || "image/jpeg",
              photo: urls[index]
            };
          }),
          settings: parts[4]
        };
      });
    });
  }

  function importAll(data) {
    if (!data || data.app !== "hub") throw new Error("Це не копія хабу");
    var counts = { tasks: 0, logs: 0, sleep: 0, food: 0 };
    var idMap = {};

    return open().then(function (db) {
      // Крок 1: задачі. Треба дочекатись, поки база роздасть їм нові id.
      var first = db.transaction(["tasks", "sleep", "settings"], "readwrite");
      var tasks = first.objectStore("tasks");
      var sleepStore = first.objectStore("sleep");
      var settingsStore = first.objectStore("settings");

      (data.tasks || []).forEach(function (task) {
        var name = String(task.name || "").trim();
        if (!name) return;
        var copy = {
          name: name,
          rule: normalizeRule(task.rule || task.recurrence_rule),
          note: task.note || "",
          active: task.active !== false,
          order: task.order || task.sort_order || 0,
          createdAt: task.createdAt || task.created_at || stamp(new Date())
        };
        var request = tasks.put(copy);
        request.onsuccess = function () { idMap[task.id] = request.result; };
        counts.tasks += 1;
      });

      (data.sleep || []).forEach(function (night) {
        if (!night.date) return;
        var entry = {
          date: night.date,
          sleepTime: night.sleepTime || night.sleep_time || null,
          wakeTime: night.wakeTime || night.wake_time || null,
          quality: night.quality || null,
          note: night.note || ""
        };
        entry.duration = durationOf(entry.sleepTime, entry.wakeTime);
        entry.naps = Array.isArray(night.naps) ? night.naps : [];
        sleepStore.put(entry);
        counts.sleep += 1;
      });

      var settings = data.settings || {};
      Object.keys(DEFAULT_SETTINGS).concat(["foodTags"]).forEach(function (key) {
        if (settings[key] !== undefined) settingsStore.put({ key: key, value: settings[key] });
      });

      return done(first).then(function () {
        // Крок 2: відмітки — вже на нові id задач.
        var second = db.transaction("taskLogs", "readwrite");
        var logs = second.objectStore("taskLogs");
        (data.taskLogs || []).forEach(function (log) {
          var oldId = log.taskId !== undefined ? log.taskId : log.task_id;
          var taskId = idMap[oldId];
          if (!taskId || !log.date) return;
          logs.put({
            key: logKey(taskId, log.date),
            taskId: taskId,
            date: log.date,
            completed: log.completed !== false && log.completed !== 0
          });
          counts.logs += 1;
        });
        return done(second);
      });
    }).then(function () {
      var items = (data.food || []).filter(function (item) { return item.ts; });
      return items.reduce(function (chain, item) {
        return chain.then(function () {
          var tags = Array.isArray(item.tags) ? item.tags : (item.tag ? [item.tag] : []);
          var entry = {
            ts: item.ts,
            date: item.date || item.ts.slice(0, 10),
            type: item.type || "image/jpeg",
            tags: tags,
            tag: mirrorTag(tags),
            note: item.note || "",
            source: item.source || "import"
          };
          counts.food += 1;
          return storeEntry(entry, item.photo ? dataUrlToBlob(item.photo) : null);
        });
      }, Promise.resolve());
    }).then(function () { return counts; });
  }

  function wipe() {
    return open().then(function (db) {
      var names = ["tasks", "taskLogs", "sleep", "food", "photos", "settings"];
      var transaction = db.transaction(names, "readwrite");
      names.forEach(function (name) { transaction.objectStore(name).clear(); });
      return done(transaction);
    });
  }

  function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate().then(function (estimate) {
      return { used: estimate.usage || 0, quota: estimate.quota || 0 };
    }).catch(function () { return null; });
  }

  function persist() {
    // Без цього браузер телефона має право почистити сховище, коли забракне місця.
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(null);
    return navigator.storage.persisted()
      .then(function (already) { return already || navigator.storage.persist(); })
      .catch(function () { return null; });
  }

  return {
    // дати
    isoOf: isoOf, today: today, shift: shift, parseISO: parseISO,
    isoWeekday: isoWeekday, mondayOf: mondayOf, fmtMinutes: fmtMinutes,
    // задачі
    ONCE: ONCE, DAILY: DAILY,
    normalizeRule: normalizeRule, describeRule: describeRule, isDue: isDue,
    createTask: createTask, updateTask: updateTask, deleteTask: deleteTask,
    moveTask: moveTask, setDone: setDone,
    listTasks: listTasks, dayPlan: dayPlan, activeStreaks: activeStreaks,
    history: history, logByDates: logByDates, taskStats: taskStats,
    perfectStreak: perfectStreak,
    // сон
    markBed: markBed, markWake: markWake, saveNight: saveNight, deleteNight: deleteNight,
    clearNight: clearNight, addNap: addNap, saveNap: saveNap, deleteNap: deleteNap,
    napMinutes: napMinutes,
    nights: nights, sleepStats: sleepStats, weeklyAverage: weeklyAverage, advisor: advisor,
    nightDateOf: nightDateOf,
    // їжа
    addPhoto: addPhoto, updateFood: updateFood, deleteFood: deleteFood,
    setTags: setTags, toggleTag: toggleTag, tagsOf: tagsOf,
    getFoodTags: getFoodTags, addFoodTag: addFoodTag,
    updateFoodTag: updateFoodTag, deleteFoodTag: deleteFoodTag,
    feed: feed, latestFood: latestFood, avoidStreak: avoidStreak, getPhoto: getPhoto,
    weeklyStats: weeklyStats, thisWeek: thisWeek, foodStats: foodStats,
    // спільне
    getSettings: getSettings, saveSettings: saveSettings,
    exportAll: exportAll, importAll: importAll, wipe: wipe, usage: usage, persist: persist
  };
})();
