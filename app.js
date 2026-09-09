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
    lastBedNotice: ""
  };

  // ── Дрібні помічники ──────────────────────────────────────────────────

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

  // Посилання на фото треба відпускати, інакше пам'ять тече при кожному малюванні.
  var urlBuckets = {};
  function objectUrl(bucket, blob) {
    var list = urlBuckets[bucket] || (urlBuckets[bucket] = []);
    var url = URL.createObjectURL(blob);
    list.push(url);
    return url;
  }
  function releaseUrls(bucket) {
    (urlBuckets[bucket] || []).forEach(function (url) { URL.revokeObjectURL(url); });
    urlBuckets[bucket] = [];
  }

  // ── Графіки: маленький свій SVG замість важкої бібліотеки ─────────────

  function barChart(items, opts) {
    var options = opts || {};
    var goal = options.goal || null;
    var H = options.height || 170;
    var unit = options.unit || "min";
    var W = 700, padL = 42, padR = 10, padT = 12, padB = 24;
    var innerW = W - padL - padR, innerH = H - padT - padB;
    var values = items.map(function (item) { return item.value || 0; });
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
      return '<rect class="bar ' + cls + '" x="' + x.toFixed(1) + '" y="' + top.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="3"><title>' +
        esc(item.title || item.label) + "</title></rect>";
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
      Hub.advisor(), Hub.sweetStreak(), Hub.thisWeek(), Hub.latestFood(6)
    ]).then(function (r) {
      var plan = r[0], streaks = r[1], week = r[2], sleepStats = r[3];
      var advice = r[4], sweet = r[5], foodWeek = r[6], latest = r[7];

      $("#ovTasksCount").innerHTML = plan.done + "<small>з " + plan.total + "</small>";
      $("#ovTasksHint").textContent = plan.total === 0
        ? "на сьогодні нічого не заплановано"
        : plan.done === plan.total ? "усе виконано" : "лишилось " + (plan.total - plan.done);

      var pending = plan.tasks.filter(function (t) { return !t.completed; }).slice(0, 5);
      $("#ovTaskList").innerHTML = pending.length
        ? pending.map(function (t) { return taskRow(t, true); }).join("")
        : '<div class="empty">Порожньо — і це добре.</div>';

      var hot = streaks.filter(function (s) { return s.streak > 0; }).slice(0, 6);
      $("#ovStreaks").innerHTML = hot.length
        ? hot.map(function (s) {
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
        return {
          label: DOW[dowIndex(n.date)],
          value: n.duration || 0,
          short: n.duration && n.duration < goal - 20,
          title: humanDate(n.date) + " · " + Hub.fmtMinutes(n.duration)
        };
      }), { goal: goal, height: 150, labelEvery: 1 });

      $("#ovSweetStreak").innerHTML = sweet.streak + "<small>" + plural(sweet.streak, "день", "дні", "днів") + "</small>";
      $("#ovSweetHint").textContent = foodWeek.sweets
        ? "цього тижня солодке " + foodWeek.sweets + " " + plural(foodWeek.sweets, "раз", "рази", "разів")
        : "цього тижня солодкого ще не було";

      releaseUrls("overview");
      $("#ovFoodThumbs").innerHTML = latest.length
        ? latest.map(function (item) {
            return item.blob
              ? '<img src="' + objectUrl("overview", item.blob) + '" alt="" title="' +
                esc(item.ts.replace("T", " ")) + '">'
              : "";
          }).join("")
        : '<span class="muted">Фото ще немає. Натисни «Сфотографувати їжу» на вкладці «Їжа».</span>';

      var banners = advice.messages.map(function (message) {
        return '<div class="banner ' + (advice.deficit ? "warn" : "calm") + '"><span class="ico">' +
          (advice.deficit ? "⚠️" : "🌙") + "</span><span>" + esc(message) + "</span></div>";
      });
      if (sweet.untagged) {
        banners.push('<div class="banner calm"><span class="ico">🍽</span><span>' + sweet.untagged +
          " " + plural(sweet.untagged, "фото чекає", "фото чекають", "фото чекають") +
          " на тег — вкладка «Їжа».</span></div>");
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
      return Promise.all([Hub.history(84), Hub.logByDates(60)]);
    }).then(function (parts) {
      renderHeatmap(parts[0]);
      var list = parts[1];
      $("#taskLog").innerHTML = list.length
        ? list.slice(0, 14).map(function (day) {
            return '<div class="list-line"><span class="mono">' + esc(day.date.slice(5)) + "</span>" +
              '<span style="text-align:right">' + day.names.map(esc).join(", ") + "</span></div>";
          }).join("")
        : '<div class="empty">Історія порожня.</div>';
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
          : "Ліг о " + hhmm(tonight.sleepTime) + ". Прокинешся — натисни другу кнопку.")
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
          return {
            label: n.date.slice(8),
            value: n.duration || 0,
            short: n.duration && n.duration < goal - 20,
            title: humanDate(n.date) + " · " + Hub.fmtMinutes(n.duration)
          };
        });
      }
      $("#sleepChart").innerHTML = barChart(items, { goal: goal, height: 190 });

      $("#sleepStats").innerHTML =
        "<span>Тиждень: <b>" + Hub.fmtMinutes(weekStats.avg) + "</b></span>" +
        "<span>Місяць: <b>" + Hub.fmtMinutes(monthStats.avg) + "</b></span>" +
        "<span>Норма: <b>" + Hub.fmtMinutes(goal) + "</b></span>" +
        (monthStats.avgQuality ? "<span>Якість: <b>" + monthStats.avgQuality + "/5</b></span>" : "");

      $("#sleepTable").innerHTML = nights.slice(-14).reverse().map(function (night) {
        return '<div class="list-line" data-night="' + night.date + '" style="flex-wrap:wrap; gap:8px">' +
          '<span class="mono" style="min-width:56px">' + DOW[dowIndex(night.date)] + " " + night.date.slice(5) + "</span>" +
          '<span class="row" style="gap:6px">' +
            '<input type="time" value="' + hhmm(night.sleepTime) + '" data-field="sleepTime" style="width:118px">' +
            '<span class="muted">→</span>' +
            '<input type="time" value="' + hhmm(night.wakeTime) + '" data-field="wakeTime" style="width:118px">' +
          "</span>" +
          '<span class="mono" style="min-width:76px; text-align:right">' + fmtShort(night.duration) + "</span>" +
          '<span class="stars">' + [1, 2, 3, 4, 5].map(function (n) {
            return '<button data-q="' + n + '" class="' + (night.quality >= n ? "on" : "") + '">★</button>';
          }).join("") + "</span></div>";
      }).join("");
    });
  }

  // ── Їжа ───────────────────────────────────────────────────────────────

  function renderFood() {
    return Promise.all([Hub.feed(120), Hub.sweetStreak(), Hub.thisWeek(), Hub.weeklyStats(8)])
      .then(function (r) {
        var feed = r[0], sweet = r[1], week = r[2], weekly = r[3];

        $("#foodStreak").innerHTML = sweet.streak + "<small>" + plural(sweet.streak, "день", "дні", "днів") + "</small>";
        $("#foodStreakHint").textContent = sweet.lastSweet
          ? "останнє солодке: " + humanDate(sweet.lastSweet) + " · рекорд " + sweet.best
          : (sweet.best ? "рекорд " + sweet.best : "солодкого ще не було в записах");

        $("#foodWeekSweets").innerHTML = week.sweets + "<small>" + plural(week.sweets, "раз", "рази", "разів") + "</small>";
        $("#foodWeekHint").textContent = week.photos + " фото з " + humanDate(week.from) +
          " · днів із солодким: " + week.sweetDays;

        $("#foodChart").innerHTML = barChart(weekly.map(function (w) {
          return {
            label: w.week.slice(5),
            value: w.sweets,
            title: "тиждень з " + humanDate(w.week) + " · солодке " + w.sweets + " з " + w.total + " фото"
          };
        }), { height: 150, unit: "count" });

        releaseUrls("feed");
        $("#foodFeed").innerHTML = feed.length
          ? feed.map(function (day) {
              return '<div class="feed-day"><h3>' +
                esc(humanDate(day.date, { day: "numeric", month: "long", weekday: "short" })) +
                ' <span class="muted">' + day.items.length + " " + plural(day.items.length, "фото", "фото", "фото") +
                (day.sweets ? " · солодке " + day.sweets : "") + "</span></h3>" +
                '<div class="shots">' + day.items.map(shotCard).join("") + "</div></div>";
            }).join("")
          : '<div class="card"><div class="empty">Фото ще немає.<br>Натисни «Сфотографувати їжу» — знімок одразу потрапить у стрічку.</div></div>';
      });
  }

  function shotCard(item) {
    return '<div class="shot" data-food="' + item.id + '">' +
      (item.blob ? '<img src="' + objectUrl("feed", item.blob) + '" alt="" loading="lazy">' : "") +
      '<div class="info"><span class="time">' + esc(item.ts.slice(11, 16)) +
      (item.note ? " · " + esc(item.note) : "") + "</span>" +
      '<div class="tagline">' +
        '<button class="tagbtn sweet" data-tag="sweet" aria-pressed="' + (item.tag === "sweet") + '">🍰 Солодке</button>' +
        '<button class="tagbtn plain" data-tag="plain" aria-pressed="' + (item.tag === "plain") + '">🥗 Звичайне</button>' +
        '<button class="tagbtn" data-drop="1" title="Видалити" aria-label="Видалити">🗑</button>' +
      "</div></div></div>";
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
    return Promise.all([Hub.getSettings(), Hub.usage()]).then(function (r) {
      var settings = r[0], usage = r[1];
      state.settings = settings;
      $("#setGoal").value = String(Number(settings.sleepGoalMinutes) / 60);
      $("#setBedtime").value = settings.bedtime || "23:00";
      $("#setWarn").value = settings.warnNights || 5;
      $("#setNotify").checked = !!settings.notifyBedtime;
      $("#usageLine").textContent = usage && usage.used
        ? "Займають на пристрої: " + (usage.used / 1048576).toFixed(1) + " МБ"
        : "";
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

  function exportBackup(withPhotos) {
    toast("Готую копію…");
    return Hub.exportAll(withPhotos).then(function (data) {
      download("hub-" + Hub.today() + (withPhotos ? "" : "-без-фото") + ".json", JSON.stringify(data));
      toast("Копію збережено");
    }).catch(fail);
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
    $("#exportBtn").addEventListener("click", function () { exportBackup(true); });
    $("#exportLightBtn").addEventListener("click", function () { exportBackup(false); });
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
        var already = tagButton.getAttribute("aria-pressed") === "true";
        Hub.updateFood(Number(card.dataset.food), { tag: already ? "" : tagButton.dataset.tag })
          .then(renderFood).catch(fail);
        return;
      }

      var dropButton = event.target.closest(".tagbtn[data-drop]");
      if (dropButton) {
        if (!confirm("Видалити це фото?")) return;
        Hub.deleteFood(Number(dropButton.closest(".shot").dataset.food)).then(renderFood).catch(fail);
        return;
      }

      var star = event.target.closest(".stars button");
      if (star) {
        var line = star.closest("[data-night]");
        Hub.saveNight(line.dataset.night, { quality: Number(star.dataset.q) }).then(renderSleep).catch(fail);
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
      if (!input) return;
      var night = input.closest("[data-night]").dataset.night;
      var patch = {};
      patch[input.dataset.field] = input.value;
      Hub.saveNight(night, patch).then(renderSleep).catch(fail);
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

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
  }

  // ── Старт ─────────────────────────────────────────────────────────────

  function init() {
    $("#todayLabel").textContent = humanDate(Hub.today(), { weekday: "long", day: "numeric", month: "long" });
    renderChips($("#newTaskDays"), state.newTaskDays);
    bind();

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
