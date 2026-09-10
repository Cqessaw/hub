/* Дашборд: одна сторінка, чотири секції. Дані бере з Hub (IndexedDB), не з мережі. */

(function () {
  "use strict";

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  var TABS = ["overview", "tasks", "sleep", "food"];

  var state = {
    tab: "overview",
    taskDay: Hub.today(),
    sleepRange: "14",
    newTaskDays: new Set([1, 3, 5]),
    editDays: new Set(),
    editing: null,
    settings: null,
    lastBedNotice: "",
    histDays: 84,
    histTask: null,
    histExpanded: false,
    foodTags: [],
    foodFilter: null,
    foodNotes: {},
    nightNotes: {},
    noteTarget: null
  };

  // ── Дрібні помічники ──────────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, "0"); }

  function humanDate(iso, opts) {
    return Hub.parseISO(iso).toLocaleDateString("uk-UA", opts || { day: "numeric", month: "long" });
  }

  function dowIndex(iso) { return Hub.isoWeekday(iso) - 1; }

  function fmtShort(minutes) {
    if (!minutes) return "—";
    return Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0");
  }

  function hhmm(value) { return value ? value.slice(11, 16) : ""; }

  function plural(n, one, few, many) {
    var mod10 = n % 10, mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
  }

  function esc(text) {
    return String(text === null || text === undefined ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var toastTimer = null;
  function toast(message) {
    var el = $("#toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2400);
  }

  function fail(error) {
    console.error(error);
    toast(error && error.message ? error.message : "Щось пішло не так");
  }

  // Одне посилання на фото живе, доки фото на екрані: створювати щоразу нове —
  // означає відкликати старе просто тоді, коли картинка ще вантажиться.
  var photoUrls = new Map();

  function photoUrl(item) {
    if (!item.blob) return "";
    var url = photoUrls.get(item.id);
    if (!url) {
      url = URL.createObjectURL(item.blob);
      photoUrls.set(item.id, url);
    }
    return url;
  }

  function prunePhotoUrls() {
    // Відпускаємо тільки те, чого вже немає в розмітці.
    var alive = new Set($$("img[data-photo]").map(function (img) { return Number(img.dataset.photo); }));
    photoUrls.forEach(function (url, id) {
      if (!alive.has(id)) {
        URL.revokeObjectURL(url);
        photoUrls.delete(id);
      }
    });
  }

  // ── Графіки: маленький свій SVG замість важкої бібліотеки ─────────────

  function barChart(items, opts) {
    var options = opts || {};
    var goal = options.goal || null;
    var H = options.height || 170;
    var unit = options.unit || "min";
    var W = 700, padL = 42, padR = 10, padT = 12, padB = 24;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var values = items.map(function (item) { return (item.value || 0) + (item.extra || 0); });
    var max = Math.max.apply(null, [goal || 0, 1].concat(values)) * 1.12;
    var step = innerW / Math.max(items.length, 1);
    var bw = Math.max(3, Math.min(30, step * 0.64));
    var y = function (v) { return padT + innerH - (v / max) * innerH; };
    var every = options.labelEvery || Math.ceil(items.length / 12);

    var bars = items.map(function (item, index) {
      var x = padL + step * index + (step - bw) / 2;
      var value = item.value || 0;
      var cls = value === 0 ? "empty" : item.short ? "short" : "";
      var top = value === 0 ? padT + innerH - 2 : y(value);
      var h = Math.max(2, padT + innerH - top);
      var out = '<rect class="bar ' + cls + '" x="' + x.toFixed(1) + '" y="' + top.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"><title>' +
        esc(item.title || item.label) + "</title></rect>";
      if (item.extra) {
        // Дрімання складається зверху на нічний сон.
        var extraTop = y(value + item.extra);
        var extraH = Math.max(2, top - extraTop);
        out += '<rect class="bar nap" x="' + x.toFixed(1) + '" y="' + extraTop.toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + extraH.toFixed(1) + '" rx="3"><title>' +
          esc(item.title || item.label) + "</title></rect>";
      }
      return out;
    }).join("");

    var labels = items.map(function (item, index) {
      if (index % every !== 0 && index !== items.length - 1) return "";
      var x = padL + step * index + step / 2;
      return '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(item.label) + "</text>";
    }).join("");

    var peak = Math.max.apply(null, values.concat([1]));
    var tickValues = unit === "min"
      ? [0, 240, 480, 720].filter(function (v) { return v <= max; })
      : [0, Math.ceil(peak / 2), peak];
    var ticks = [];
    Array.from(new Set(tickValues)).forEach(function (value) {
      ticks.push('<line class="axis" x1="' + padL + '" y1="' + y(value).toFixed(1) +
        '" x2="' + (W - padR) + '" y2="' + y(value).toFixed(1) + '" opacity=".5"/>');
      ticks.push('<text x="' + (padL - 6) + '" y="' + (y(value) + 3).toFixed(1) + '" text-anchor="end">' +
        (unit === "min" ? value / 60 + " год" : value) + "</text>");
    });

    var goalLine = goal
      ? '<line class="goal" x1="' + padL + '" y1="' + y(goal).toFixed(1) + '" x2="' + (W - padR) +
        '" y2="' + y(goal).toFixed(1) + '"/>'
      : "";

    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img">' +
      ticks.join("") + goalLine + bars + labels + "</svg>";
  }

  // ── Рядок задачі ──────────────────────────────────────────────────────

  function taskRow(task, compact) {
    var streak = task.streak
      ? '<span class="pill">' + task.streak + " " + plural(task.streak, "день", "дні", "днів") + "</span>"
      : task.recurring ? '<span class="pill cold">0</span>' : "";
    var actions = compact ? "" :
      '<div class="task-actions">' +
        '<button class="icon-btn tiny" data-move="' + task.id + '" data-dir="-1" title="Вище" aria-label="Вище">↑</button>' +
        '<button class="icon-btn tiny" data-move="' + task.id + '" data-dir="1" title="Нижче" aria-label="Нижче">↓</button>' +
        '<button class="icon-btn tiny" data-edit="' + task.id + '" title="Змінити" aria-label="Змінити">✎</button>' +
      "</div>";
    return '<div class="task' + (task.completed ? " done" : "") + '" data-id="' + task.id + '">' +
      '<button class="check" data-toggle="' + task.id + '" aria-label="Відмітити виконаним">✓</button>' +
      '<div class="name">' + esc(task.name) +
        '<div class="meta">' + esc(task.ruleLabel) + (task.note ? " · " + esc(task.note) : "") + "</div>" +
      "</div>" + streak + actions + "</div>";
  }

  // ── Огляд ─────────────────────────────────────────────────────────────

  function renderOverview() {
    return Promise.all([
      Hub.dayPlan(), Hub.activeStreaks(), Hub.nights(7), Hub.sleepStats(7),
      Hub.advisor(), Hub.avoidStreak(), Hub.thisWeek(), Hub.latestFood(6),
      Hub.perfectStreak(), Hub.getSettings()
    ]).then(function (r) {
      var plan = r[0], streaks = r[1], week = r[2], sleepStats = r[3];
      var advice = r[4], sweet = r[5], foodWeek = r[6], latest = r[7];
      var perfect = r[8], settings = r[9];

      $("#ovTasksCount").innerHTML = plan.done + "<small>з " + plan.total + "</small>";
      $("#ovTasksHint").textContent = plan.total === 0
        ? "на сьогодні нічого не заплановано"
        : plan.done === plan.total ? "усе виконано" : "лишилось " + (plan.total - plan.done);

      var pending = plan.tasks.filter(function (t) { return !t.completed; }).slice(0, 5);
      $("#ovTaskList").innerHTML = pending.length
        ? pending.map(function (t) { return taskRow(t, true); }).join("")
        : '<div class="empty">Порожньо — і це добре.</div>';

      var hot = streaks.filter(function (s) { return s.streak > 0; }).slice(0, 6);
      // Ідеальні дні — це про день загалом, тому стоять першими.
      var perfectLine = perfect.streak
        ? '<div class="list-line"><span><b>Ідеальні дні</b> <span class="muted">· весь план</span></span>' +
          '<span class="pill accent">' + perfect.streak + " " +
          plural(perfect.streak, "день", "дні", "днів") + "</span></div>"
        : "";
      $("#ovStreaks").innerHTML = (perfectLine || hot.length)
        ? perfectLine + hot.map(function (s) {
            return '<div class="list-line"><span>' + esc(s.name) +
              ' <span class="muted">· ' + esc(s.ruleLabel) + "</span></span>" +
              '<span class="pill">' + s.streak + " " + plural(s.streak, "день", "дні", "днів") + "</span></div>";
          }).join("")
        : '<div class="empty">Стріки з\'являться, щойно з\'явиться повторювана задача.</div>';

      var goal = advice.goalMinutes;
      $("#ovSleepAvg").innerHTML = sleepStats.avg ? Hub.fmtMinutes(sleepStats.avg) : "—<small>немає записів</small>";
      $("#ovSleepHint").textContent = sleepStats.avg
        ? "норма " + Hub.fmtMinutes(goal) + " · ночей у вибірці: " + sleepStats.nights
        : "натисни «Ліг спати» на вкладці «Сон»";
      $("#ovSleepChart").innerHTML = barChart(week.map(function (n) {
        var title = humanDate(n.date) + " · " + Hub.fmtMinutes(n.duration);
        if (n.napMinutes) title += " + дрімання " + Hub.fmtMinutes(n.napMinutes);
        return {
          label: DOW[dowIndex(n.date)],
          value: n.duration || 0,
          extra: n.napMinutes || 0,
          short: n.duration && n.duration < goal - 20,
          title: title
        };
      }), { goal: goal, height: 150, labelEvery: 1 });

      $("#ovSweetTitle").textContent = sweet.onlySweet ? "Без солодкого" : "Без зривів";
      $("#ovSweetStreak").innerHTML = sweet.streak + "<small>" + plural(sweet.streak, "день", "дні", "днів") + "</small>";
      $("#ovSweetHint").textContent = foodWeek.avoid
        ? "цього тижня зривів: " + foodWeek.avoid
        : "цього тижня зривів ще не було";

      $("#ovFoodThumbs").innerHTML = latest.length
        ? latest.map(function (item) {
            return item.blob
              ? '<img src="' + photoUrl(item) + '" data-photo="' + item.id + '" alt="" title="' +
                esc(item.ts.replace("T", " ")) + '">'
              : "";
          }).join("")
        : '<span class="muted">Фото ще немає. Натисни «Сфотографувати їжу» на вкладці «Їжа».</span>';
      prunePhotoUrls();

      var banners = advice.messages.map(function (message) {
        return '<div class="banner ' + (advice.deficit ? "warn" : "calm") + '"><span class="ico">' +
          (advice.deficit ? "⚠️" : "🌙") + "</span><span>" + esc(message) + "</span></div>";
      });
      if (sweet.untagged) {
        banners.push('<div class="banner calm"><span class="ico">🍽</span><span>' + sweet.untagged +
          " " + plural(sweet.untagged, "фото чекає", "фото чекають", "фото чекають") +
          " на категорію — вкладка «Їжа».</span></div>");
      }
      var hasData = plan.total || latest.length || sleepStats.nights;
      var stale = backupAge(settings.lastBackupAt);
      if (hasData && (stale === null || stale >= 14)) {
        banners.push('<div class="banner warn"><span class="ico">💾</span><span>' +
          (stale === null
            ? "Копії ще не було — дані живуть лише на цьому телефоні."
            : "Останню копію робив " + stale + " " + plural(stale, "день", "дні", "днів") + " тому.") +
          ' <button class="link-btn" data-open-settings>Зберегти зараз</button></span></div>');
      }
      $("#overviewBanners").innerHTML = banners.join("");
    });
  }

  // ── Задачі ────────────────────────────────────────────────────────────

  function renderTasks() {
    var isToday = state.taskDay === Hub.today();
    return Hub.dayPlan(state.taskDay).then(function (plan) {
      $("#taskDayLabel").textContent = isToday
        ? "Сьогодні · " + humanDate(state.taskDay)
        : DOW[dowIndex(state.taskDay)] + ", " + humanDate(state.taskDay);
      $("#dayToday").hidden = isToday;
      $("#taskList").innerHTML = plan.tasks.length
        ? plan.tasks.map(function (t) { return taskRow(t); }).join("")
        : '<div class="empty">На цей день задач немає.</div>';
      return renderHistory();
    });
  }

  function renderHistory() {
    return Promise.all([
      Hub.listTasks(Hub.today(), true),
      Hub.history(state.histDays, null, state.histTask),
      Hub.logByDates(state.histDays, null, state.histTask),
      state.histTask ? Hub.taskStats(state.histTask, state.histDays) : Promise.resolve(null)
    ]).then(function (r) {
      var tasks = r[0], heat = r[1], list = r[2], stats = r[3];

      // Задача могла зникнути — тоді повертаємось до загального вигляду.
      if (state.histTask && !tasks.some(function (t) { return t.id === state.histTask; })) {
        state.histTask = null;
        return renderHistory();
      }

      $("#histFilter").innerHTML = '<button class="chip" data-hist="" aria-pressed="' +
        (state.histTask === null) + '">Усі</button>' +
        tasks.filter(function (t) { return t.recurring; }).map(function (t) {
          return '<button class="chip" data-hist="' + t.id + '" aria-pressed="' +
            (state.histTask === t.id) + '">' + esc(t.name) + "</button>";
        }).join("");

      var totalDone = list.reduce(function (sum, day) { return sum + day.names.length; }, 0);
      if (stats) {
        var parts = [
          "<b>" + esc(stats.name) + "</b> · " + esc(stats.ruleLabel),
          "виконано <b>" + stats.done + "</b>" + (stats.planned ? " з " + stats.planned + " запланованих" : ""),
          "≈ <b>" + stats.perWeek + "</b> " + plural(Math.round(stats.perWeek), "раз", "рази", "разів") + " на тиждень",
          "стрік <b>" + stats.streak + "</b>, рекорд <b>" + stats.best + "</b>"
        ];
        $("#histSummary").innerHTML = parts.join(" · ");
      } else {
        $("#histSummary").innerHTML = "Усього відміток за період: <b>" + totalDone + "</b>" +
          ". Обери задачу, щоб побачити її окремо.";
      }

      renderHeatmap(heat);

      var shown = state.histExpanded ? list : list.slice(0, 14);
      $("#taskLog").innerHTML = shown.length
        ? shown.map(function (day) {
            return '<div class="list-line"><span class="mono">' + esc(day.date.slice(5)) + "</span>" +
              '<span style="text-align:right">' + day.names.map(esc).join(", ") + "</span></div>";
          }).join("")
        : '<div class="empty">За цей період відміток немає.</div>';

      var more = $("#histMore");
      more.hidden = list.length <= 14;
      more.textContent = state.histExpanded
        ? "Згорнути"
        : "Показати всі " + list.length + " " + plural(list.length, "день", "дні", "днів");
    });
  }

  function renderHeatmap(heatmap) {
    var days = heatmap.days;
    if (!days.length) { $("#taskHeat").innerHTML = ""; return; }
    var weeks = [];
    var current = new Array(7).fill(null);
    days.forEach(function (day) {
      var index = dowIndex(day.date);
      if (index === 0 && current.some(function (c) { return c !== null; })) {
        weeks.push(current);
        current = new Array(7).fill(null);
      }
      current[index] = day;
    });
    weeks.push(current);
    $("#taskHeat").innerHTML = weeks.map(function (week) {
      return '<div class="week">' + week.map(function (day) {
        if (!day) return '<i style="visibility:hidden"></i>';
        if (day.ratio === null) return '<i title="' + esc(day.date) + ' · нічого не заплановано"></i>';
        var level = day.ratio >= 1 ? 3 : day.ratio >= 0.5 ? 2 : day.ratio > 0 ? 1 : 0;
        return '<i data-level="' + level + '" title="' + esc(day.date) + " · " + day.done + "/" + day.planned + '"></i>';
      }).join("") + "</div>";
    }).join("");
  }

  function renderChips(container, chosen) {
    container.innerHTML = DOW.map(function (name, index) {
      var day = index + 1;
      return '<button type="button" data-day="' + day + '" aria-pressed="' + chosen.has(day) + '">' + name + "</button>";
    }).join("");
  }

  function ruleFrom(selectValue, chosen) {
    if (selectValue !== "days") return selectValue;
    var days = Array.from(chosen).sort(function (a, b) { return a - b; });
    return days.length ? "days:" + days.join(",") : "daily";
  }

  // ── Сон ───────────────────────────────────────────────────────────────

  function sideDate(night, value, kind) {
    // Під полем показуємо, на яку саме добу випадає цей час.
    var hour = value ? Number(value.slice(0, 2)) : null;
    var day;
    if (kind === "sleep") day = (hour === null || hour >= 12) ? night : Hub.shift(night, 1);
    else day = (hour !== null && hour >= 18) ? night : Hub.shift(night, 1);
    return humanDate(day, { day: "numeric", month: "short" });
  }

  function napRow(nap, index) {
    var minutes = Hub.napMinutes(nap);
    return '<div class="nap" data-nap="' + index + '">' +
      '<span class="nap-ico">💤</span>' +
      '<input type="time" data-nap-field="start" value="' + (nap.start || "") + '">' +
      '<span class="muted">→</span>' +
      '<input type="time" data-nap-field="end" value="' + (nap.end || "") + '">' +
      '<span class="mono nap-dur">' + (minutes ? fmtShort(minutes) : "—") + "</span>" +
      '<button class="icon-btn tiny" data-del-nap="' + index + '" title="Прибрати" aria-label="Прибрати">✕</button>' +
      "</div>";
  }

  function nightRow(night) {
    var naps = night.naps || [];
    return '<div class="night" data-night="' + night.date + '">' +
      '<div class="night-row">' +
        '<span class="mono night-date">' + DOW[dowIndex(night.date)] + " " + night.date.slice(5) + "</span>" +
        '<span class="timepair">' +
          '<span class="tf"><input type="time" data-field="sleepTime" value="' + hhmm(night.sleepTime) + '">' +
            "<em>" + esc(sideDate(night.date, hhmm(night.sleepTime), "sleep")) + "</em></span>" +
          '<span class="muted">→</span>' +
          '<span class="tf"><input type="time" data-field="wakeTime" value="' + hhmm(night.wakeTime) + '">' +
            "<em>" + esc(sideDate(night.date, hhmm(night.wakeTime), "wake")) + "</em></span>" +
        "</span>" +
        '<span class="mono dur">' + fmtShort(night.duration) + "</span>" +
        '<span class="stars" data-value="' + (night.quality || 0) +
          '" title="Натисни ту саму зірку ще раз, щоб прибрати оцінку">' +
          [1, 2, 3, 4, 5].map(function (n) {
            return '<button data-q="' + n + '" class="' + (night.quality >= n ? "on" : "") + '">★</button>';
          }).join("") + "</span>" +
        '<button class="icon-btn tiny" data-note-night title="Нотатка" aria-label="Нотатка">✎</button>' +
        '<button class="icon-btn tiny" data-clear-night title="Прибрати години сну" aria-label="Прибрати години сну">✕</button>' +
      "</div>" +
      (night.note ? '<div class="night-note muted">' + esc(night.note) + "</div>" : "") +
      '<div class="naps">' +
        naps.map(napRow).join("") +
        '<button class="btn ghost nap-add" data-add-nap>＋ дрімання</button>' +
      "</div>" +
    "</div>";
  }

  function renderSleep() {
    return Promise.all([
      Hub.nights(60), Hub.weeklyAverage(8), Hub.sleepStats(7), Hub.sleepStats(30), Hub.advisor()
    ]).then(function (r) {
      var nights = r[0], weekly = r[1], weekStats = r[2], monthStats = r[3], advice = r[4];
      var goal = advice.goalMinutes;

      var tonight = advice.tonight;
      $("#sleepTonight").textContent = tonight && tonight.sleepTime
        ? (tonight.wakeTime
          ? "Ніч " + humanDate(tonight.date) + ": " + hhmm(tonight.sleepTime) + " → " +
            hhmm(tonight.wakeTime) + ", " + Hub.fmtMinutes(tonight.duration) + "."
          : "Ліг о " + hhmm(tonight.sleepTime) + " (" + humanDate(tonight.date) +
            "). Прокинешся — натисни другу кнопку.")
        : "Сьогодні ще нічого не записано.";

      $("#sleepBanners").innerHTML = advice.messages.map(function (message) {
        return '<div class="banner ' + (advice.deficit ? "warn" : "calm") + '"><span class="ico">' +
          (advice.deficit ? "⚠️" : "🌙") + "</span><span>" + esc(message) + "</span></div>";
      }).join("");

      var items;
      if (state.sleepRange === "weeks") {
        items = weekly.map(function (w) {
          return {
            label: w.week.slice(5),
            value: w.avg,
            short: w.avg < goal - 20,
            title: "тиждень з " + humanDate(w.week) + " · середнє " + Hub.fmtMinutes(w.avg) + " за " + w.nights + " ноч."
          };
        });
      } else {
        items = nights.slice(-Number(state.sleepRange)).map(function (n) {
          var title = humanDate(n.date) + " · " + Hub.fmtMinutes(n.duration);
          if (n.napMinutes) title += " + дрімання " + Hub.fmtMinutes(n.napMinutes);
          return {
            label: n.date.slice(8),
            value: n.duration || 0,
            extra: n.napMinutes || 0,
            short: n.duration && n.duration < goal - 20,
            title: title
          };
        });
      }
      $("#sleepChart").innerHTML = barChart(items, { goal: goal, height: 190 });

      $("#sleepStats").innerHTML =
        "<span>Тиждень: <b>" + Hub.fmtMinutes(weekStats.avg) + "</b></span>" +
        "<span>Місяць: <b>" + Hub.fmtMinutes(monthStats.avg) + "</b></span>" +
        "<span>Норма: <b>" + Hub.fmtMinutes(goal) + "</b></span>" +
        (monthStats.avgQuality ? "<span>Якість: <b>" + monthStats.avgQuality + "/5</b></span>" : "") +
        (monthStats.napMinutes
          ? "<span>Дрімання за місяць: <b>" + Hub.fmtMinutes(monthStats.napMinutes) + "</b> за " +
            monthStats.napDays + " " + plural(monthStats.napDays, "день", "дні", "днів") + "</span>"
          : "");

      var recent = nights.slice(-14).reverse();
      state.nightNotes = {};
      recent.forEach(function (night) { state.nightNotes[night.date] = night.note || ""; });
      $("#sleepTable").innerHTML = recent.map(nightRow).join("");
    });
  }

  // ── Їжа ───────────────────────────────────────────────────────────────

  function renderFood() {
    return Promise.all([
      Hub.feed(120), Hub.avoidStreak(), Hub.thisWeek(), Hub.weeklyStats(8), Hub.getFoodTags()
    ]).then(function (r) {
      var feed = r[0], streak = r[1], week = r[2], weekly = r[3], tags = r[4];
      state.foodTags = tags;
      state.foodNotes = {};
      feed.forEach(function (day) {
        day.items.forEach(function (item) { state.foodNotes[item.id] = item.note || ""; });
      });
      // Фільтр показуємо лише тоді, коли є що фільтрувати.
      var filterBox = $("#foodFilter");
      filterBox.hidden = !feed.length;
      filterBox.innerHTML = '<button class="chip" data-food-filter="" aria-pressed="' +
        (state.foodFilter === null) + '">Усі</button>' +
        tags.map(function (tag) {
          return '<button class="chip" data-food-filter="' + tag.id + '" aria-pressed="' +
            (state.foodFilter === tag.id) + '">' + tag.emoji + " " + esc(tag.name) + "</button>";
        }).join("");

      var shown = state.foodFilter
        ? feed.map(function (day) {
            return {
              date: day.date,
              avoid: day.avoid,
              items: day.items.filter(function (item) {
                return (item.tags || []).indexOf(state.foodFilter) !== -1;
              })
            };
          }).filter(function (day) { return day.items.length; })
        : feed;

      $("#foodStreakTitle").textContent = streak.onlySweet ? "Без солодкого" : "Без зривів";
      $("#foodStreak").innerHTML = streak.streak + "<small>" +
        plural(streak.streak, "день", "дні", "днів") + "</small>";
      $("#foodStreakHint").textContent = streak.avoidNames.length
        ? (streak.last ? "останній зрив: " + humanDate(streak.last) + " · рекорд " + streak.best
                       : "рекорд " + streak.best) +
          " · рахується: " + streak.avoidNames.join(", ")
        : "жодна категорія не позначена як «уникаю»";

      $("#foodWeekSweets").innerHTML = week.avoid + "<small>" +
        plural(week.avoid, "зрив", "зриви", "зривів") + "</small>";
      $("#foodWeekHint").textContent = week.photos + " " + plural(week.photos, "фото", "фото", "фото") +
        " з " + humanDate(week.from) + " · днів зі зривом: " + week.avoidDays;

      $("#foodTagStats").innerHTML = week.byTag.length
        ? week.byTag.map(function (t) {
            return '<div class="list-line"><span>' + t.emoji + " " + esc(t.name) +
              (t.avoid ? ' <span class="muted">уникаю</span>' : "") + "</span>" +
              '<span class="pill' + (t.count ? (t.avoid ? " hot" : " good") : " cold") + '">' +
              t.count + "</span></div>";
          }).join("")
        : '<div class="empty">Категорій немає.</div>';

      $("#foodChart").innerHTML = barChart(weekly.map(function (w) {
        return {
          label: w.week.slice(5),
          value: w.avoid,
          title: "тиждень з " + humanDate(w.week) + " · зривів " + w.avoid + " з " + w.total + " фото"
        };
      }), { height: 150, unit: "count" });

      $("#foodFeed").innerHTML = shown.length
        ? shown.map(function (day) {
            return '<div class="feed-day"><h3>' +
              esc(humanDate(day.date, { day: "numeric", month: "long", weekday: "short" })) +
              ' <span class="muted">' + day.items.length + " " + plural(day.items.length, "фото", "фото", "фото") +
              (day.avoid ? " · зривів " + day.avoid : "") + "</span></h3>" +
              '<div class="shots">' + day.items.map(function (item) {
                return shotCard(item, tags);
              }).join("") + "</div></div>";
          }).join("")
        : '<div class="card"><div class="empty">' + (feed.length
            ? "У цій категорії фото немає."
            : "Фото ще немає.<br>Натисни «Сфотографувати їжу» — знімок одразу потрапить у стрічку.") +
          "</div></div>";
      prunePhotoUrls();
    });
  }

  function shotCard(item, tags) {
    // На картці лишаємо самі значки — інакше п'ять категорій розтягують її на пів екрана.
    var picked = item.tags || [];
    var chips = tags.map(function (tag) {
      var on = picked.indexOf(tag.id) !== -1;
      return '<button class="tagbtn icon' + (tag.avoid ? " avoid" : "") + '" data-tag="' + tag.id +
        '" aria-pressed="' + on + '" title="' + esc(tag.name) + '" aria-label="' + esc(tag.name) + '">' +
        tag.emoji + "</button>";
    }).join("");
    var names = tags.filter(function (tag) { return picked.indexOf(tag.id) !== -1; })
      .map(function (tag) { return esc(tag.name); }).join(" · ");
    return '<div class="shot" data-food="' + item.id + '">' +
      (item.blob ? '<img src="' + photoUrl(item) + '" data-photo="' + item.id + '" alt="" loading="lazy">' : "") +
      '<div class="info"><span class="time">' + esc(item.ts.slice(11, 16)) +
      (item.note ? " · " + esc(item.note) : "") + "</span>" +
      '<div class="tagline">' + chips +
        '<button class="tagbtn icon ghost" data-note title="Нотатка" aria-label="Нотатка">✎</button>' +
        '<button class="tagbtn icon ghost" data-tags-edit="1" title="Налаштувати категорії">＋</button>' +
        '<button class="tagbtn icon ghost" data-drop="1" title="Видалити" aria-label="Видалити">🗑</button>' +
      "</div>" +
      '<span class="tag-names muted">' + (names || "без категорії") + "</span>" +
      "</div></div>";
  }

  // ── Категорії їжі ─────────────────────────────────────────────────────

  function renderTagList(tags) {
    $("#tagList").innerHTML = tags.map(function (tag) {
      return '<div class="list-line tag-line" data-tag-id="' + tag.id + '">' +
        "<span>" + tag.emoji + " " + esc(tag.name) + "</span>" +
        '<span class="wrap-row">' +
          '<label class="check-line"><input type="checkbox" data-tag-avoid ' +
            (tag.avoid ? "checked" : "") + '><span class="muted">уникаю</span></label>' +
          '<button class="icon-btn tiny" data-tag-del title="Прибрати" aria-label="Прибрати">✕</button>' +
        "</span></div>";
    }).join("");
  }

  function openTagsDialog() {
    return Hub.getFoodTags().then(function (tags) {
      state.foodTags = tags;
      renderTagList(tags);
      $("#tagsDialog").showModal();
    });
  }

  function acceptPhotos(files, source) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.resolve();
    return list.reduce(function (chain, file) {
      return chain.then(function () { return Hub.addPhoto(file, { source: source }); });
    }, Promise.resolve()).then(function () {
      toast(list.length === 1 ? "Фото збережено — постав тег" : list.length + " фото збережено");
      return renderFood();
    }).catch(fail);
  }

  // ── Налаштування, копії ───────────────────────────────────────────────

  function openSettings() {
    return Promise.all([Hub.getSettings(), Hub.usage(), Hub.persist()]).then(function (r) {
      var settings = r[0], usage = r[1], persisted = r[2];
      state.settings = settings;
      $("#setGoal").value = String(Number(settings.sleepGoalMinutes) / 60);
      $("#setBedtime").value = settings.bedtime || "23:00";
      $("#setWarn").value = settings.warnNights || 5;
      $("#setNotify").checked = !!settings.notifyBedtime;
      $("#usageLine").textContent = usage && usage.used
        ? "Займають на пристрої: " + (usage.used / 1048576).toFixed(1) + " МБ"
        : "";
      $("#persistLine").textContent = persisted === null ? ""
        : persisted
          ? "Сховище захищене: браузер не почистить дані сам."
          : "Браузер не дав захист сховища — копії тут особливо важливі.";
      $("#backupPhotos").value = settings.backupPhotos || "3";
      var age = backupAge(settings.lastBackupAt);
      $("#backupLine").textContent = age === null
        ? "Копії ще не було."
        : "Остання копія: " + humanDate(settings.lastBackupAt.slice(0, 10)) +
          (age ? " (" + age + " " + plural(age, "день", "дні", "днів") + " тому)" : " (сьогодні)");
      $("#shareBtn").hidden = !canShareFiles();
      $("#settingsDialog").showModal();
    });
  }

  function saveSettingsFromForm() {
    var wantsNotify = $("#setNotify").checked;
    var apply = function (allowed) {
      return Hub.saveSettings({
        sleepGoalMinutes: Math.round(Number($("#setGoal").value || 8) * 60),
        bedtime: $("#setBedtime").value || "23:00",
        warnNights: Number($("#setWarn").value || 5),
        notifyBedtime: allowed
      });
    };
    var ready = wantsNotify && "Notification" in window && Notification.permission === "default"
      ? Notification.requestPermission().then(function (result) { return result === "granted"; })
      : Promise.resolve(wantsNotify && (!("Notification" in window) ? false : Notification.permission === "granted"));

    return ready.then(function (allowed) {
      if (wantsNotify && !allowed) toast("Браузер не дав дозволу на сповіщення");
      return apply(allowed);
    }).then(function () {
      $("#settingsDialog").close();
      toast("Збережено");
      return refresh();
    }).catch(fail);
  }

  function download(name, text) {
    var url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function backupAge(iso) {
    if (!iso) return null;
    var days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return days < 0 ? 0 : days;
  }

  function backupMode() {
    var value = ($("#backupPhotos") || {}).value || "3";
    return (value === "all" || value === "none") ? value : Number(value);
  }

  function backupName(mode) {
    var suffix = mode === "none" ? "-без-фото" : (mode === "all" ? "" : "-фото-" + mode + "міс");
    return "hub-" + Hub.today() + suffix + ".json";
  }

  function markBackupDone() {
    return Hub.saveSettings({ lastBackupAt: new Date().toISOString() });
  }

  function exportBackup() {
    var mode = backupMode();
    toast("Готую копію…");
    return Hub.exportAll(mode).then(function (data) {
      download(backupName(mode), JSON.stringify(data));
      return markBackupDone();
    }).then(function () {
      toast("Копію збережено");
    }).catch(fail);
  }

  function canShareFiles() {
    if (!navigator.canShare || !navigator.share || typeof File !== "function") return false;
    try {
      return navigator.canShare({ files: [new File(["{}"], "a.json", { type: "application/json" })] });
    } catch (e) {
      return false;
    }
  }

  function shareBackup() {
    // На телефоні зручніше відправити копію собі в месенджер, ніж шукати теку завантажень.
    var mode = backupMode();
    toast("Готую копію…");
    return Hub.exportAll(mode).then(function (data) {
      var file = new File([JSON.stringify(data)], backupName(mode), { type: "application/json" });
      return navigator.share({ files: [file], title: "Копія Хабу" }).then(markBackupDone);
    }).then(function () {
      toast("Надіслано");
    }).catch(function (error) {
      if (error && error.name === "AbortError") return;   // просто передумав
      fail(error);
    });
  }

  function importBackup(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (e) { toast("Не вдалося прочитати файл"); return; }
      if (!confirm("Додати дані з копії до нинішніх? Наявні записи не стираються.")) return;
      Hub.importAll(data).then(function (counts) {
        toast("Додано: задач " + counts.tasks + ", відміток " + counts.logs +
          ", ночей " + counts.sleep + ", фото " + counts.food);
        return refresh();
      }).catch(fail);
    };
    reader.readAsText(file);
  }

  // ── Нотатки ───────────────────────────────────────────────────────────

  function openNote(kind, key, title) {
    var current = kind === "food" ? state.foodNotes[key] : state.nightNotes[key];
    state.noteTarget = { kind: kind, key: key };
    $("#noteTitle").textContent = title;
    $("#noteText").value = current || "";
    $("#noteDialog").showModal();
    setTimeout(function () { $("#noteText").focus(); }, 60);
  }

  function saveNote() {
    var target = state.noteTarget;
    if (!target) return Promise.resolve();
    var text = $("#noteText").value;
    var job = target.kind === "food"
      ? Hub.updateFood(target.key, { note: text }).then(renderFood)
      : Hub.saveNight(target.key, { note: text }).then(renderSleep);
    return job.then(function () {
      $("#noteDialog").close();
      state.noteTarget = null;
    }).catch(fail);
  }

  // ── Діалог задачі ─────────────────────────────────────────────────────

  function openTaskDialog(task) {
    state.editing = task;
    state.editDays = new Set(task.rule.indexOf("days:") === 0
      ? task.rule.slice(5).split(",").map(Number) : []);
    $("#editName").value = task.name;
    $("#editRule").value = task.rule === "once" ? "once" : task.rule === "daily" ? "daily" : "days";
    $("#editNote").value = task.note || "";
    $("#editActive").checked = task.active !== false;
    $("#editDays").hidden = $("#editRule").value !== "days";
    renderChips($("#editDays"), state.editDays);
    $("#taskDialog").showModal();
  }

  function saveTaskDialog() {
    if (!state.editing) return Promise.resolve();
    return Hub.updateTask(state.editing.id, {
      name: $("#editName").value,
      rule: ruleFrom($("#editRule").value, state.editDays),
      note: $("#editNote").value,
      active: $("#editActive").checked
    }).then(function () {
      $("#taskDialog").close();
      toast("Збережено");
      return refresh();
    }).catch(fail);
  }

  // ── Помічник сну: сповіщення ──────────────────────────────────────────

  function checkBedtimeNotice() {
    if (document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
    Hub.getSettings().then(function (settings) {
      if (!settings.notifyBedtime) return;
      return Hub.advisor().then(function (advice) {
        var stampKey = Hub.today();
        if (state.lastBedNotice === stampKey) return;
        if (advice.minutesToBed > 15 || advice.minutesToBed < -60) return;
        state.lastBedNotice = stampKey;
        var text = advice.deficit
          ? "Останні ночі коротші за норму — варто лягти вчасно."
          : "Орієнтир — " + advice.bedtime + ".";
        new Notification("Час лягати", { body: text, icon: "icons/icon-192.png", tag: "hub-bedtime" });
      });
    }).catch(function () { /* сповіщення — не привід ламати сторінку */ });
  }

  // ── Ніякого масштабування ─────────────────────────────────────────────

  function lockZoom() {
    // iOS Safari ігнорує user-scalable, тож щипок доводиться глушити вручну.
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (name) {
      document.addEventListener(name, function (event) { event.preventDefault(); }, { passive: false });
    });
    // На iPhone gesture-події спрацьовують не завжди — ловимо сам дотик двома
    // пальцями. Одним пальцем сторінка гортається як зазвичай.
    document.addEventListener("touchmove", function (event) {
      if (event.touches.length > 1) event.preventDefault();
    }, { passive: false, capture: true });
    // Ctrl+колесо і щипок на тачпаді комп'ютера.
    document.addEventListener("wheel", function (event) {
      if (event.ctrlKey) event.preventDefault();
    }, { passive: false });
    // Подвійний клік не має нічого виділяти чи наближати.
    document.addEventListener("dblclick", function (event) { event.preventDefault(); }, { passive: false });
  }

  // ── Встановлення на телефон ───────────────────────────────────────────

  var installPrompt = null;

  function isStandalone() {
    return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  }

  function installHidden() {
    try { return localStorage.getItem("hub_install_hidden") === "1"; } catch (e) { return false; }
  }

  function updateInstallHint() {
    var hint = $("#installHint");
    if (isStandalone() || installHidden()) { hint.hidden = true; return; }
    if (installPrompt) {
      $("#installBtn").hidden = false;
      $("#installText").textContent = "Відкриватиметься з іконки й працюватиме без інтернету.";
      hint.hidden = false;
    } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
      // iOS не дає програмного запиту — лишається підказати шлях.
      $("#installBtn").hidden = true;
      $("#installText").textContent = "Кнопка «Поділитися» внизу Safari → «На екран „Домівка“».";
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  // ── Навігація ─────────────────────────────────────────────────────────

  function showTab(name) {
    state.tab = name;
    $$("#tabs button").forEach(function (b) {
      b.setAttribute("aria-selected", String(b.dataset.tab === name));
    });
    TABS.forEach(function (tab) { $("#tab-" + tab).hidden = tab !== name; });
    try { localStorage.setItem("hub_tab", name); } catch (e) { /* байдуже */ }
    refresh();
  }

  function refresh() {
    var job = state.tab === "overview" ? renderOverview()
      : state.tab === "tasks" ? renderTasks()
      : state.tab === "sleep" ? renderSleep()
      : renderFood();
    return job.catch(fail);
  }

  // ── Події ─────────────────────────────────────────────────────────────

  function bind() {
    $("#tabs").addEventListener("click", function (event) {
      var button = event.target.closest("button[data-tab]");
      if (button) showTab(button.dataset.tab);
    });

    $("#themeBtn").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "latte" ? "mocha" : "latte";
      document.documentElement.setAttribute("data-theme", next);
      document.querySelector('meta[name="theme-color"]')
        .setAttribute("content", next === "latte" ? "#F4F1EB" : "#181825");
      try { localStorage.setItem("hub_theme", next); } catch (e) { /* байдуже */ }
    });

    $("#settingsBtn").addEventListener("click", function () { openSettings().catch(fail); });
    $("#setClose").addEventListener("click", function () { saveSettingsFromForm(); });
    $("#shareBtn").addEventListener("click", function () { shareBackup(); });
    $("#exportBtn").addEventListener("click", function () { exportBackup(); });
    $("#backupPhotos").addEventListener("change", function () {
      Hub.saveSettings({ backupPhotos: $("#backupPhotos").value }).catch(function () { /* дрібниця */ });
    });
    $("#noteCancel").addEventListener("click", function () {
      $("#noteDialog").close();
      state.noteTarget = null;
    });
    $("#noteSave").addEventListener("click", function () { saveNote(); });
    $("#importBtn").addEventListener("click", function () { $("#importFile").click(); });
    $("#importFile").addEventListener("change", function (event) {
      var file = event.target.files[0];
      if (file) importBackup(file);
      event.target.value = "";
    });
    $("#wipeBtn").addEventListener("click", function () {
      if (!confirm("Стерти всі задачі, ночі та фото? Це не відновити без копії.")) return;
      Hub.wipe().then(function () {
        $("#settingsDialog").close();
        toast("Стерто");
        return refresh();
      }).catch(fail);
    });

    $("#editCancel").addEventListener("click", function () { $("#taskDialog").close(); });
    [["#editUp", -1], ["#editDown", 1]].forEach(function (pair) {
      $(pair[0]).addEventListener("click", function () {
        if (!state.editing) return;
        Hub.moveTask(state.editing.id, pair[1]).then(function (moved) {
          toast(moved === null ? "Далі нікуди" : "Переставив");
          return refresh();
        }).catch(fail);
      });
    });
    $("#editSave").addEventListener("click", function () { saveTaskDialog(); });
    $("#editRule").addEventListener("change", function () {
      $("#editDays").hidden = $("#editRule").value !== "days";
    });
    $("#editDelete").addEventListener("click", function () {
      if (!state.editing) return;
      if (!confirm("Видалити задачу разом з історією?")) return;
      Hub.deleteTask(state.editing.id).then(function () {
        $("#taskDialog").close();
        toast("Видалено");
        return refresh();
      }).catch(fail);
    });

    document.addEventListener("click", function (event) {
      var toggle = event.target.closest("[data-toggle]");
      if (toggle) {
        var row = toggle.closest(".task");
        var completed = !row.classList.contains("done");
        row.classList.toggle("done", completed);
        var day = state.tab === "tasks" ? state.taskDay : Hub.today();
        Hub.setDone(Number(toggle.dataset.toggle), day, completed).then(refresh).catch(fail);
        return;
      }

      var move = event.target.closest("[data-move]");
      if (move) {
        Hub.moveTask(Number(move.dataset.move), Number(move.dataset.dir)).then(refresh).catch(fail);
        return;
      }

      var edit = event.target.closest("[data-edit]");
      if (edit) {
        Hub.listTasks(state.taskDay, true).then(function (tasks) {
          var task = tasks.find(function (t) { return t.id === Number(edit.dataset.edit); });
          if (task) openTaskDialog(task);
        }).catch(fail);
        return;
      }

      var chip = event.target.closest(".daychips button");
      if (chip) {
        var inDialog = chip.closest("#editDays");
        var set = inDialog ? state.editDays : state.newTaskDays;
        var day2 = Number(chip.dataset.day);
        if (set.has(day2)) set.delete(day2); else set.add(day2);
        renderChips(inDialog ? $("#editDays") : $("#newTaskDays"), set);
        return;
      }

      var tagButton = event.target.closest(".tagbtn[data-tag]");
      if (tagButton) {
        var card = tagButton.closest(".shot");
        // Категорій може бути кілька — просто вмикаємо або вимикаємо одну.
        tagButton.setAttribute("aria-pressed",
          String(tagButton.getAttribute("aria-pressed") !== "true"));
        Hub.toggleTag(Number(card.dataset.food), tagButton.dataset.tag)
          .then(renderFood).catch(fail);
        return;
      }

      var dropButton = event.target.closest(".tagbtn[data-drop]");
      if (dropButton) {
        if (!confirm("Видалити це фото?")) return;
        Hub.deleteFood(Number(dropButton.closest(".shot").dataset.food)).then(renderFood).catch(fail);
        return;
      }

      var openSettings2 = event.target.closest("[data-open-settings]");
      if (openSettings2) {
        openSettings().catch(fail);
        return;
      }

      var foodChip = event.target.closest("[data-food-filter]");
      if (foodChip) {
        var value = foodChip.dataset.foodFilter;
        state.foodFilter = value || null;
        renderFood().catch(fail);
        return;
      }

      var noteBtn = event.target.closest("[data-note]");
      if (noteBtn) {
        var shot = noteBtn.closest(".shot");
        openNote("food", Number(shot.dataset.food), "Нотатка до знімка");
        return;
      }

      var nightNote = event.target.closest("[data-note-night]");
      if (nightNote) {
        var noteNight = nightNote.closest("[data-night]").dataset.night;
        openNote("night", noteNight, "Нотатка про ніч " + humanDate(noteNight));
        return;
      }

      var histChip = event.target.closest("[data-hist]");
      if (histChip) {
        var raw = histChip.dataset.hist;
        state.histTask = raw ? Number(raw) : null;
        state.histExpanded = false;
        renderHistory().catch(fail);
        return;
      }

      var histDays = event.target.closest("[data-hist-days]");
      if (histDays) {
        state.histDays = Number(histDays.dataset.histDays);
        $$("[data-hist-days]").forEach(function (b) {
          b.setAttribute("aria-pressed", String(b === histDays));
        });
        state.histExpanded = false;
        renderHistory().catch(fail);
        return;
      }

      var clearNight = event.target.closest("[data-clear-night]");
      if (clearNight) {
        var nightBox = clearNight.closest("[data-night]");
        Hub.clearNight(nightBox.dataset.night).then(function () {
          toast("Години сну прибрано");
          return renderSleep();
        }).catch(fail);
        return;
      }

      var addNap = event.target.closest("[data-add-nap]");
      if (addNap) {
        var napNight = addNap.closest("[data-night]").dataset.night;
        var now = new Date();
        var end = pad2(now.getHours()) + ":" + pad2(now.getMinutes());
        var from = new Date(now.getTime() - 30 * 60000);
        var start = pad2(from.getHours()) + ":" + pad2(from.getMinutes());
        Hub.addNap(napNight, start, end).then(function () {
          toast("Додав дрімання — поправ час, якщо треба");
          return renderSleep();
        }).catch(fail);
        return;
      }

      var delNap = event.target.closest("[data-del-nap]");
      if (delNap) {
        var napBox = delNap.closest("[data-night]");
        Hub.deleteNap(napBox.dataset.night, Number(delNap.dataset.delNap))
          .then(renderSleep).catch(fail);
        return;
      }

      var tagsEdit = event.target.closest("[data-tags-edit]");
      if (tagsEdit) {
        openTagsDialog().catch(fail);
        return;
      }

      var tagDel = event.target.closest("[data-tag-del]");
      if (tagDel) {
        var tagId = tagDel.closest("[data-tag-id]").dataset.tagId;
        if (!confirm("Прибрати категорію? Вона зникне і зі знімків.")) return;
        Hub.deleteFoodTag(tagId).then(function () {
          toast("Прибрано");
          return openTagsDialog();
        }).catch(fail);
        return;
      }

      var star = event.target.closest(".stars button");
      if (star) {
        var line = star.closest("[data-night]");
        var picked = Number(star.dataset.q);
        var current = Number(star.parentNode.dataset.value || 0);
        // Та сама зірка вдруге — оцінку знято (0 у сховищі означає «немає»).
        var next = picked === current ? 0 : picked;
        Hub.saveNight(line.dataset.night, { quality: next }).then(function () {
          if (!next) toast("Оцінку прибрано");
          return renderSleep();
        }).catch(fail);
      }
    });

    $("#addTask").addEventListener("click", function () {
      var input = $("#newTaskName");
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      Hub.createTask(name, ruleFrom($("#newTaskRule").value, state.newTaskDays)).then(function () {
        input.value = "";
        toast("Додано");
        return refresh();
      }).catch(fail);
    });
    $("#newTaskName").addEventListener("keydown", function (event) {
      if (event.key === "Enter") $("#addTask").click();
    });
    $("#newTaskRule").addEventListener("change", function () {
      $("#newTaskDays").hidden = $("#newTaskRule").value !== "days";
    });

    $("#dayPrev").addEventListener("click", function () {
      state.taskDay = Hub.shift(state.taskDay, -1);
      renderTasks().catch(fail);
    });
    $("#dayNext").addEventListener("click", function () {
      state.taskDay = Hub.shift(state.taskDay, 1);
      renderTasks().catch(fail);
    });
    $("#dayToday").addEventListener("click", function () {
      state.taskDay = Hub.today();
      renderTasks().catch(fail);
    });

    $("#btnBed").addEventListener("click", function () {
      Hub.markBed().then(function () { toast("Добраніч 🌙"); return refresh(); }).catch(fail);
    });
    $("#btnWake").addEventListener("click", function () {
      Hub.markWake().then(function (night) {
        toast(night && night.duration ? "Сон: " + Hub.fmtMinutes(night.duration) : "Записано");
        return refresh();
      }).catch(fail);
    });
    $$("[data-range]").forEach(function (button) {
      button.addEventListener("click", function () {
        state.sleepRange = button.dataset.range;
        $$("[data-range]").forEach(function (b) { b.setAttribute("aria-pressed", String(b === button)); });
        renderSleep().catch(fail);
      });
    });
    $("#sleepTable").addEventListener("change", function (event) {
      var input = event.target.closest("input[data-field]");
      if (input) {
        var night = input.closest("[data-night]").dataset.night;
        var patch = {};
        patch[input.dataset.field] = input.value;
        Hub.saveNight(night, patch).then(renderSleep).catch(fail);
        return;
      }
      var napInput = event.target.closest("input[data-nap-field]");
      if (napInput) {
        var box = napInput.closest("[data-night]");
        var index = Number(napInput.closest("[data-nap]").dataset.nap);
        var napPatch = {};
        napPatch[napInput.dataset.napField] = napInput.value;
        Hub.saveNap(box.dataset.night, index, napPatch).then(renderSleep).catch(fail);
      }
    });

    $("#tagsBtn").addEventListener("click", function () { openTagsDialog().catch(fail); });
    $("#tagsClose").addEventListener("click", function () {
      $("#tagsDialog").close();
      renderFood().catch(fail);
    });
    $("#tagAdd").addEventListener("click", function () {
      var name = $("#tagName").value.trim();
      if (!name) { $("#tagName").focus(); return; }
      Hub.addFoodTag(name, $("#tagEmoji").value, $("#tagAvoid").checked).then(function () {
        $("#tagName").value = "";
        $("#tagEmoji").value = "";
        $("#tagAvoid").checked = false;
        toast("Додано");
        return openTagsDialog();
      }).catch(fail);
    });
    $("#tagList").addEventListener("change", function (event) {
      var box = event.target.closest("[data-tag-avoid]");
      if (!box) return;
      var id = box.closest("[data-tag-id]").dataset.tagId;
      Hub.updateFoodTag(id, { avoid: box.checked }).catch(fail);
    });

    $("#histMore").addEventListener("click", function () {
      state.histExpanded = !state.histExpanded;
      renderHistory().catch(fail);
    });

    $("#foodShoot").addEventListener("click", function () { $("#foodCamera").click(); });
    $("#foodPick").addEventListener("click", function () { $("#foodFile").click(); });
    $("#foodCamera").addEventListener("change", function (event) {
      acceptPhotos(event.target.files, "camera");
      event.target.value = "";
    });
    $("#foodFile").addEventListener("change", function (event) {
      acceptPhotos(event.target.files, "gallery");
      event.target.value = "";
    });

    $("#installBtn").addEventListener("click", function () {
      if (!installPrompt) return;
      installPrompt.prompt();
      installPrompt.userChoice.then(function () {
        installPrompt = null;
        updateInstallHint();
      });
    });
    $("#installDismiss").addEventListener("click", function () {
      try { localStorage.setItem("hub_install_hidden", "1"); } catch (e) { /* байдуже */ }
      $("#installHint").hidden = true;
    });
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      installPrompt = event;
      updateInstallHint();
    });
    window.addEventListener("appinstalled", function () {
      installPrompt = null;
      $("#installHint").hidden = true;
      toast("Готово — тепер відкривай з іконки");
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
  }

  // ── Старт ─────────────────────────────────────────────────────────────

  function init() {
    $("#todayLabel").textContent = humanDate(Hub.today(), { weekday: "long", day: "numeric", month: "long" });
    renderChips($("#newTaskDays"), state.newTaskDays);
    lockZoom();
    bind();
    // Просимо захист сховища одразу: телефон не має права стерти щоденник сам.
    Hub.persist().catch(function () { /* не всі браузери це вміють */ });
    updateInstallHint();

    var saved = "overview";
    try { saved = localStorage.getItem("hub_tab") || "overview"; } catch (e) { /* байдуже */ }
    showTab(TABS.indexOf(saved) !== -1 ? saved : "overview");

    setInterval(function () {
      checkBedtimeNotice();
      if (state.tab === "overview" && !document.hidden) renderOverview().catch(function () {});
    }, 60000);
    checkBedtimeNotice();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
