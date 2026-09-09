/* Сховище й уся логіка трьох модулів. Дані живуть у IndexedDB прямо в браузері:
   ніякого сервера, ніякої мережі, нічого не виходить за межі пристрою. */

var Hub = (function () {
  "use strict";

  var DB_NAME = "hub";
  var DB_VERSION = 1;
  var dbPromise = null;

  var DEFAULT_SETTINGS = {
    sleepGoalMinutes: 480,   // бажана норма сну, хвилин
    bedtime: "23:00",        // орієнтовний час лягати
    warnNights: 5,           // скільки останніх ночей дивиться помічник
    notifyBedtime: false,    // системне нагадування, коли застосунок відкритий
    theme: ""                // "" = за системою
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
        void event;
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

  function history(days, end) {
    var last = end || today();
    var first = shift(last, -(days - 1));
    return taskContext().then(function (ctx) {
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
        var planned = ctx.tasks.filter(function (task) {
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

  function logByDates(days, end) {
    var last = end || today();
    var first = shift(last, -(days - 1));
    return taskContext().then(function (ctx) {
      var names = {};
      ctx.tasks.forEach(function (t) { names[t.id] = t.name; });
      return Object.keys(ctx.doneByDate)
        .filter(function (date) { return date >= first && date <= last; })
        .sort().reverse()
        .map(function (date) {
          return {
            date: date,
            names: ctx.doneByDate[date]
              .map(function (id) { return names[id]; })
              .filter(Boolean)
          };
        });
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
        var entry = row || { date: night, sleepTime: null, wakeTime: null, duration: null, quality: null, note: "" };
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

  function nights(days, end) {
    var last = end || today();
    var first = shift(last, -(days - 1));
    return getAll("sleep").then(function (rows) {
      var byDate = {};
      rows.forEach(function (row) { byDate[row.date] = row; });
      var out = [];
      var cursor = first;
      while (cursor <= last) {
        out.push(byDate[cursor] || { date: cursor, sleepTime: null, wakeTime: null, duration: null, quality: null, note: "" });
        cursor = shift(cursor, 1);
      }
      return out;
    });
  }

  function statsOf(rows) {
    var filled = rows.filter(function (r) { return r.duration; });
    if (!filled.length) return { nights: 0, avg: null, min: null, max: null, avgQuality: null };
    var durations = filled.map(function (r) { return r.duration; });
    var qualities = filled.filter(function (r) { return r.quality; }).map(function (r) { return r.quality; });
    return {
      nights: filled.length,
      avg: Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length),
      min: Math.min.apply(null, durations),
      max: Math.max.apply(null, durations),
      avgQuality: qualities.length
        ? Math.round((qualities.reduce(function (a, b) { return a + b; }, 0) / qualities.length) * 10) / 10
        : null
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

  var SWEET = "sweet";
  var PLAIN = "plain";
  var TAGS = { sweet: "Солодке", plain: "Звичайне" };
  var MAX_SIDE = 1280;

  function normalizeTag(tag) {
    if (tag === null || tag === undefined || tag === "") return null;
    var clean = String(tag).trim().toLowerCase();
    if (clean === "none" || clean === "null") return null;
    if (clean === SWEET || clean === PLAIN) return clean;
    throw new Error("Невідомий тег: " + tag);
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
          resolve(blob && blob.size < file.size ? blob : file);
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
      return put("food", {
        ts: stamp(moment),
        date: isoOf(moment),
        blob: blob,
        type: blob.type || "image/jpeg",
        tag: normalizeTag(opts.tag),
        note: String(opts.note || "").trim(),
        source: opts.source || "camera"
      });
    });
  }

  function updateFood(id, patch) {
    return open().then(function (db) {
      var transaction = db.transaction("food", "readwrite");
      var store = transaction.objectStore("food");
      return req(store.get(id)).then(function (entry) {
        if (!entry) throw new Error("Запису немає");
        if (patch.tag !== undefined) entry.tag = normalizeTag(patch.tag);
        if (patch.note !== undefined) entry.note = String(patch.note).trim();
        return req(store.put(entry)).then(function () { return entry; });
      });
    });
  }

  function deleteFood(id) { return remove("food", id); }

  function foodRows() {
    return getAll("food").then(function (rows) {
      return rows.sort(function (a, b) { return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id; });
    });
  }

  function feed(limit) {
    return foodRows().then(function (rows) {
      var slice = rows.slice(0, limit || 120);
      var groups = [];
      var index = {};
      slice.forEach(function (item) {
        item.tagLabel = TAGS[item.tag] || "Без тегу";
        if (index[item.date] === undefined) {
          index[item.date] = groups.length;
          groups.push({ date: item.date, items: [], sweets: 0 });
        }
        var group = groups[index[item.date]];
        group.items.push(item);
        if (item.tag === SWEET) group.sweets += 1;
      });
      return groups;
    });
  }

  function latestFood(limit) {
    return foodRows().then(function (rows) { return rows.slice(0, limit || 6); });
  }

  function sweetStreak(end) {
    var last = end || today();
    return foodRows().then(function (rows) {
      if (!rows.length) {
        // Жодного запису — рахувати нічого, і «1 день» тут виглядало б обманом.
        return { streak: 0, lastSweet: null, best: 0, untagged: 0 };
      }
      var sweetDays = new Set(rows.filter(function (r) { return r.tag === SWEET; })
        .map(function (r) { return r.date; }));
      var floor = rows[rows.length - 1].date;

      var count = 0;
      var cursor = last;
      while (cursor >= floor && count < 366) {
        if (sweetDays.has(cursor)) break;
        count += 1;
        cursor = shift(cursor, -1);
      }

      var best = 0, current = 0;
      var walk = floor;
      while (walk <= last) {
        if (sweetDays.has(walk)) current = 0;
        else { current += 1; best = Math.max(best, current); }
        walk = shift(walk, 1);
      }

      var sorted = Array.from(sweetDays).sort();
      return {
        streak: count,
        lastSweet: sorted.length ? sorted[sorted.length - 1] : null,
        best: best,
        untagged: rows.filter(function (r) { return !r.tag; }).length
      };
    });
  }

  function weeklyStats(weeks, end) {
    var last = end || today();
    var first = mondayOf(shift(last, -(weeks * 7 - 1)));
    return foodRows().then(function (rows) {
      var buckets = {};
      var cursor = first;
      while (cursor <= last) {
        buckets[cursor] = { week: cursor, sweets: 0, total: 0, sweetDays: 0 };
        cursor = shift(cursor, 7);
      }
      var sweetDates = {};
      rows.forEach(function (row) {
        if (row.date < first || row.date > last) return;
        var week = mondayOf(row.date);
        var bucket = buckets[week] || (buckets[week] = { week: week, sweets: 0, total: 0, sweetDays: 0 });
        bucket.total += 1;
        if (row.tag === SWEET) {
          bucket.sweets += 1;
          (sweetDates[week] = sweetDates[week] || new Set()).add(row.date);
        }
      });
      Object.keys(sweetDates).forEach(function (week) {
        buckets[week].sweetDays = sweetDates[week].size;
      });
      return Object.keys(buckets).sort().map(function (week) { return buckets[week]; });
    });
  }

  function thisWeek(end) {
    var last = end || today();
    var monday = mondayOf(last);
    return foodRows().then(function (rows) {
      var inWeek = rows.filter(function (r) { return r.date >= monday && r.date <= last; });
      var sweets = inWeek.filter(function (r) { return r.tag === SWEET; });
      return {
        from: monday,
        photos: inWeek.length,
        sweets: sweets.length,
        sweetDays: new Set(sweets.map(function (r) { return r.date; })).size
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

  function exportAll(withPhotos) {
    return Promise.all([
      getAll("tasks"), getAll("taskLogs"), getAll("sleep"), foodRows(), getSettings()
    ]).then(function (parts) {
      var food = parts[3];
      var photos = withPhotos
        ? Promise.all(food.map(function (item) {
            return item.blob ? blobToDataUrl(item.blob) : Promise.resolve(null);
          }))
        : Promise.resolve(food.map(function () { return null; }));
      return photos.then(function (urls) {
        return {
          app: "hub",
          version: 1,
          exportedAt: new Date().toISOString(),
          withPhotos: !!withPhotos,
          tasks: parts[0],
          taskLogs: parts[1],
          sleep: parts[2],
          food: food.map(function (item, index) {
            return {
              ts: item.ts, date: item.date, tag: item.tag || null,
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
        sleepStore.put(entry);
        counts.sleep += 1;
      });

      var settings = data.settings || {};
      Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
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
          var entry = {
            ts: item.ts,
            date: item.date || item.ts.slice(0, 10),
            blob: item.photo ? dataUrlToBlob(item.photo) : null,
            type: item.type || "image/jpeg",
            tag: item.tag || null,
            note: item.note || "",
            source: item.source || "import"
          };
          counts.food += 1;
          return put("food", entry);
        });
      }, Promise.resolve());
    }).then(function () { return counts; });
  }

  function wipe() {
    return open().then(function (db) {
      var names = ["tasks", "taskLogs", "sleep", "food", "settings"];
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
    history: history, logByDates: logByDates,
    // сон
    markBed: markBed, markWake: markWake, saveNight: saveNight, deleteNight: deleteNight,
    nights: nights, sleepStats: sleepStats, weeklyAverage: weeklyAverage, advisor: advisor,
    nightDateOf: nightDateOf,
    // їжа
    TAGS: TAGS, addPhoto: addPhoto, updateFood: updateFood, deleteFood: deleteFood,
    feed: feed, latestFood: latestFood, sweetStreak: sweetStreak,
    weeklyStats: weeklyStats, thisWeek: thisWeek,
    // спільне
    getSettings: getSettings, saveSettings: saveSettings,
    exportAll: exportAll, importAll: importAll, wipe: wipe, usage: usage, persist: persist
  };
})();
