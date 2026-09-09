/* Спільний дашборд: одна сторінка, чотири секції, усе через /api. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
const state = {
  tab: "overview",
  taskDay: todayISO(),
  sleepRange: "14",
  sleepData: null,
  foodData: null,
  settings: {},
  newTaskDays: new Set([1, 3, 5]),
};

// ── Дрібні помічники ────────────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function humanDate(iso, opts = { day: "numeric", month: "long" }) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("uk-UA", opts);
}

function dowIndex(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7; // 0 = понеділок
}

function fmtMinutes(min) {
  if (!min && min !== 0) return "—";
  return `${Math.floor(min / 60)} год ${String(min % 60).padStart(2, "0")} хв`;
}

function fmtShort(min) {
  if (!min) return "—";
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

function hhmm(isoTime) {
  return isoTime ? isoTime.slice(11, 16) : "";
}

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

async function api(path, options = {}) {
  const init = { headers: {}, ...options };
  if (init.body && !(init.body instanceof FormData)) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail || detail; } catch (e) { /* байдуже */ }
    toast(`Помилка: ${detail}`);
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

// ── Графіки: маленький свій SVG замість важкої бібліотеки ───────────────────

function barChart(items, opts = {}) {
  const { goal = null, height = 170, unit = "min", labelEvery = null } = opts;
  const W = 700, H = height, padL = 42, padR = 10, padT = 12, padB = 24;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const values = items.map((i) => i.value || 0);
  const max = Math.max(goal || 0, ...values, 1) * 1.12;
  const step = innerW / Math.max(items.length, 1);
  const bw = Math.max(3, Math.min(30, step * 0.64));
  const y = (v) => padT + innerH - (v / max) * innerH;
  const every = labelEvery || Math.ceil(items.length / 12);

  const bars = items.map((item, index) => {
    const x = padL + step * index + (step - bw) / 2;
    const value = item.value || 0;
    const cls = value === 0 ? "empty" : item.short ? "short" : "";
    const top = value === 0 ? padT + innerH - 2 : y(value);
    const h = Math.max(2, padT + innerH - top);
    const title = `${item.title || item.label}`;
    return `<rect class="bar ${cls}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${esc(title)}</title></rect>`;
  }).join("");

  const labels = items.map((item, index) => {
    if (index % every !== 0 && index !== items.length - 1) return "";
    const x = padL + step * index + step / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(item.label)}</text>`;
  }).join("");

  const ticks = [];
  const peak = Math.max(...values, 1);
  const tickValues = unit === "min"
    ? [0, 240, 480, 720].filter((v) => v <= max)
    : [0, Math.ceil(peak / 2), peak];
  for (const value of [...new Set(tickValues)]) {
    ticks.push(`<line class="axis" x1="${padL}" y1="${y(value).toFixed(1)}" x2="${W - padR}" y2="${y(value).toFixed(1)}" opacity=".5"/>`);
    ticks.push(`<text x="${padL - 6}" y="${(y(value) + 3).toFixed(1)}" text-anchor="end">${unit === "min" ? value / 60 + " год" : value}</text>`);
  }

  const goalLine = goal
    ? `<line class="goal" x1="${padL}" y1="${y(goal).toFixed(1)}" x2="${W - padR}" y2="${y(goal).toFixed(1)}"/>`
    : "";

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${ticks.join("")}${goalLine}${bars}${labels}</svg>`;
}

// ── Огляд ───────────────────────────────────────────────────────────────────

async function renderOverview() {
  const data = await api("/api/dashboard");
  const { tasks, sleep, food } = data;

  $("#ovTasksCount").innerHTML = `${tasks.done}<small>з ${tasks.total}</small>`;
  $("#ovTasksHint").textContent = tasks.total === 0
    ? "на сьогодні нічого не заплановано"
    : tasks.done === tasks.total ? "усе виконано" : `лишилось ${tasks.total - tasks.done}`;

  const pending = tasks.items.filter((t) => !t.completed).slice(0, 5);
  $("#ovTaskList").innerHTML = pending.length
    ? pending.map((t) => taskRow(t, true)).join("")
    : `<div class="empty">Порожньо — і це добре.</div>`;

  $("#ovStreaks").innerHTML = tasks.streaks.length
    ? tasks.streaks.map((s) => `
        <div class="list-line">
          <span>${esc(s.name)} <span class="muted">· ${esc(s.rule_label)}</span></span>
          <span class="pill">${s.streak} ${plural(s.streak, "день", "дні", "днів")}</span>
        </div>`).join("")
    : `<div class="empty">Стріки з'являться, щойно з'явиться повторювана задача.</div>`;

  const goal = sleep.advisor.goal_minutes;
  $("#ovSleepAvg").innerHTML = sleep.stats.avg
    ? `${fmtMinutes(sleep.stats.avg)}`
    : `—<small>немає записів</small>`;
  $("#ovSleepHint").textContent = sleep.stats.avg
    ? `норма ${fmtMinutes(goal)} · ночей у вибірці: ${sleep.stats.nights}`
    : "натисни «Ліг спати» на вкладці «Сон»";
  $("#ovSleepChart").innerHTML = barChart(
    sleep.week.map((n) => ({
      label: DOW[dowIndex(n.date)],
      value: n.duration || 0,
      short: n.duration && n.duration < goal - 20,
      title: `${humanDate(n.date)} · ${fmtMinutes(n.duration)}`,
    })),
    { goal, height: 150, labelEvery: 1 }
  );

  $("#ovSweetStreak").innerHTML = `${food.streak.streak}<small>${plural(food.streak.streak, "день", "дні", "днів")}</small>`;
  $("#ovSweetHint").textContent = food.week.sweets
    ? `цього тижня солодке ${food.week.sweets} ${plural(food.week.sweets, "раз", "рази", "разів")}`
    : "цього тижня солодкого ще не було";
  $("#ovFoodThumbs").innerHTML = food.latest.length
    ? food.latest.map((f) => `<img src="/api/food/${f.id}/photo" alt="" title="${esc(f.timestamp.slice(0, 16).replace("T", " "))}" loading="lazy">`).join("")
    : `<span class="muted">Фото ще немає. Надішли перше боту або додай на вкладці «Їжа».</span>`;

  const banners = [];
  for (const message of sleep.advisor.messages) {
    banners.push(`<div class="banner ${sleep.advisor.deficit ? "warn" : "calm"}"><span class="ico">${sleep.advisor.deficit ? "⚠️" : "🌙"}</span><span>${esc(message)}</span></div>`);
  }
  if (food.untagged) {
    banners.push(`<div class="banner calm"><span class="ico">🍽</span><span>${food.untagged} ${plural(food.untagged, "фото чекає", "фото чекають", "фото чекають")} на тег — вкладка «Їжа».</span></div>`);
  }
  $("#overviewBanners").innerHTML = banners.join("");
}

// ── Задачі ──────────────────────────────────────────────────────────────────

function taskRow(task, compact = false) {
  const streak = task.streak
    ? `<span class="pill">${task.streak} ${plural(task.streak, "день", "дні", "днів")}</span>`
    : task.recurring ? `<span class="pill cold">0</span>` : "";
  const actions = compact ? "" : `
    <div class="task-actions">
      <button class="icon-btn" data-edit="${task.id}" title="Перейменувати">✎</button>
      <button class="icon-btn" data-del="${task.id}" title="Видалити">🗑</button>
    </div>`;
  return `
    <div class="task ${task.completed ? "done" : ""}" data-id="${task.id}">
      <button class="check" data-toggle="${task.id}" aria-label="Відмітити">✓</button>
      <div class="name">${esc(task.name)}
        <div class="meta">${esc(task.rule_label)}${task.note ? " · " + esc(task.note) : ""}</div>
      </div>
      ${streak}
      ${actions}
    </div>`;
}

async function renderTasks() {
  const plan = await api(`/api/tasks?day=${state.taskDay}`);
  const isToday = state.taskDay === todayISO();
  $("#taskDayLabel").textContent = isToday
    ? `Сьогодні · ${humanDate(state.taskDay)}`
    : `${DOW[dowIndex(state.taskDay)]}, ${humanDate(state.taskDay)}`;
  $("#dayToday").hidden = isToday;
  $("#taskList").innerHTML = plan.tasks.length
    ? plan.tasks.map((t) => taskRow(t)).join("")
    : `<div class="empty">На цей день задач немає.</div>`;

  const history = await api("/api/tasks/history?days=84");
  renderHeatmap(history.heatmap);
  $("#taskLog").innerHTML = history.list.length
    ? history.list.slice(0, 14).map((day) => `
        <div class="list-line">
          <span class="mono">${esc(day.date.slice(5))}</span>
          <span style="text-align:right">${day.names.map(esc).join(", ")}</span>
        </div>`).join("")
    : `<div class="empty">Історія порожня.</div>`;
}

function renderHeatmap(heatmap) {
  const days = heatmap.days;
  if (!days.length) { $("#taskHeat").innerHTML = ""; return; }
  const weeks = [];
  let current = new Array(7).fill(null);
  for (const day of days) {
    const index = dowIndex(day.date);
    if (index === 0 && current.some((c) => c !== null)) {
      weeks.push(current);
      current = new Array(7).fill(null);
    }
    current[index] = day;
  }
  weeks.push(current);
  $("#taskHeat").innerHTML = weeks.map((week) => `
    <div class="week">${week.map((day) => {
      if (!day) return `<i style="visibility:hidden"></i>`;
      if (day.ratio === null) return `<i title="${esc(day.date)} · нічого не заплановано"></i>`;
      const level = day.ratio >= 1 ? 3 : day.ratio >= 0.5 ? 2 : day.ratio > 0 ? 1 : 0;
      return `<i data-level="${level}" title="${esc(day.date)} · ${day.done}/${day.planned}"></i>`;
    }).join("")}</div>`).join("");
}

function ruleFromForm() {
  const kind = $("#newTaskRule").value;
  if (kind !== "days") return kind;
  const days = [...state.newTaskDays].sort();
  return days.length ? `days:${days.join(",")}` : "daily";
}

function renderDayChips() {
  $("#newTaskDays").innerHTML = DOW.map((name, index) => {
    const day = index + 1;
    return `<button type="button" data-day="${day}" aria-pressed="${state.newTaskDays.has(day)}">${name}</button>`;
  }).join("");
}

// ── Сон ─────────────────────────────────────────────────────────────────────

async function renderSleep() {
  const data = await api("/api/sleep?days=60");
  state.sleepData = data;
  const goal = data.advisor.goal_minutes;

  const tonight = data.advisor.tonight;
  $("#sleepTonight").textContent = tonight && tonight.sleep_time
    ? (tonight.wake_time
      ? `Ніч ${humanDate(tonight.date)}: ${hhmm(tonight.sleep_time)} → ${hhmm(tonight.wake_time)}, ${fmtMinutes(tonight.duration)}.`
      : `Ліг о ${hhmm(tonight.sleep_time)}. Прокинешся — натисни другу кнопку.`)
    : "Сьогодні ще нічого не записано.";

  $("#sleepBanners").innerHTML = data.advisor.messages
    .map((m) => `<div class="banner ${data.advisor.deficit ? "warn" : "calm"}"><span class="ico">${data.advisor.deficit ? "⚠️" : "🌙"}</span><span>${esc(m)}</span></div>`)
    .join("");

  let items;
  if (state.sleepRange === "weeks") {
    items = data.weekly.map((w) => ({
      label: w.week.slice(5),
      value: w.avg,
      short: w.avg < goal - 20,
      title: `тиждень з ${humanDate(w.week)} · середнє ${fmtMinutes(w.avg)} за ${w.nights} ноч.`,
    }));
  } else {
    const count = Number(state.sleepRange);
    items = data.nights.slice(-count).map((n) => ({
      label: n.date.slice(8),
      value: n.duration || 0,
      short: n.duration && n.duration < goal - 20,
      title: `${humanDate(n.date)} · ${fmtMinutes(n.duration)}`,
    }));
  }
  $("#sleepChart").innerHTML = barChart(items, { goal, height: 190 });

  const week = data.stats.week, month = data.stats.month;
  $("#sleepStats").innerHTML = `
    <span>Тиждень: <b>${fmtMinutes(week.avg)}</b></span>
    <span>Місяць: <b>${fmtMinutes(month.avg)}</b></span>
    <span>Норма: <b>${fmtMinutes(goal)}</b></span>
    ${month.avg_quality ? `<span>Якість: <b>${month.avg_quality}/5</b></span>` : ""}`;

  const rows = data.nights.slice(-14).reverse();
  $("#sleepTable").innerHTML = rows.map((night) => `
    <div class="list-line" data-night="${night.date}" style="flex-wrap:wrap; gap:8px">
      <span class="mono" style="min-width:56px">${DOW[dowIndex(night.date)]} ${night.date.slice(5)}</span>
      <span class="row" style="gap:6px">
        <input type="time" value="${hhmm(night.sleep_time)}" data-field="sleep_time" style="width:118px">
        <span class="muted">→</span>
        <input type="time" value="${hhmm(night.wake_time)}" data-field="wake_time" style="width:118px">
      </span>
      <span class="mono" style="min-width:76px; text-align:right">${fmtShort(night.duration)}</span>
      <span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-q="${n}" class="${night.quality >= n ? "on" : ""}">★</button>`).join("")}</span>
    </div>`).join("");
}

// ── Їжа ─────────────────────────────────────────────────────────────────────

async function renderFood() {
  const data = await api("/api/food?limit=120");
  state.foodData = data;

  $("#foodStreak").innerHTML = `${data.streak.streak}<small>${plural(data.streak.streak, "день", "дні", "днів")}</small>`;
  $("#foodStreakHint").textContent = data.streak.last_sweet
    ? `останнє солодке: ${humanDate(data.streak.last_sweet)} · рекорд ${data.streak.best}`
    : `рекорд ${data.streak.best}`;

  $("#foodWeekSweets").innerHTML = `${data.week.sweets}<small>${plural(data.week.sweets, "раз", "рази", "разів")}</small>`;
  $("#foodWeekHint").textContent = `${data.week.photos} ${plural(data.week.photos, "фото", "фото", "фото")} з ${humanDate(data.week.from)} · днів із солодким: ${data.week.sweet_days}`;

  $("#foodChart").innerHTML = barChart(
    data.weekly.map((w) => ({
      label: w.week.slice(5),
      value: w.sweets,
      title: `тиждень з ${humanDate(w.week)} · солодке ${w.sweets} з ${w.total} фото`,
    })),
    { height: 150, unit: "count" }
  );

  $("#foodSource").textContent = data.vision
    ? "Фото приймає Telegram-бот, тег підказує Claude — лишається підтвердити."
    : "Фото приймає Telegram-бот. Тег ставиться двома кнопками.";

  $("#foodFeed").innerHTML = data.feed.length
    ? data.feed.map((day) => `
        <div class="feed-day">
          <h3>${esc(humanDate(day.date, { day: "numeric", month: "long", weekday: "short" }))}
            <span class="muted">${day.items.length} ${plural(day.items.length, "фото", "фото", "фото")}${day.sweets ? ` · солодке ${day.sweets}` : ""}</span>
          </h3>
          <div class="shots">
            ${day.items.map((item) => shotCard(item)).join("")}
          </div>
        </div>`).join("")
    : `<div class="card"><div class="empty">Фото ще немає.<br>Надішли фото боту в Telegram або натисни «Додати фото з комп'ютера».</div></div>`;
}

function shotCard(item) {
  const hint = item.suggested_tag && !item.tag
    ? `<div class="muted" style="font-size:11px">Claude: ${esc(item.suggestion_note || (item.suggested_tag === "sweet" ? "солодке" : "звичайне"))}</div>`
    : "";
  return `
    <div class="shot" data-food="${item.id}">
      ${item.photo_path ? `<img src="/api/food/${item.id}/photo" alt="" loading="lazy">` : ""}
      <div class="info">
        <span class="time">${esc(item.timestamp.slice(11, 16))}${item.note ? " · " + esc(item.note) : ""}</span>
        ${hint}
        <div class="tagline">
          <button class="tagbtn sweet" data-tag="sweet" aria-pressed="${item.tag === "sweet"}">🍰 Солодке</button>
          <button class="tagbtn plain" data-tag="plain" aria-pressed="${item.tag === "plain"}">🥗 Звичайне</button>
          <button class="tagbtn" data-drop="1" title="Видалити">🗑</button>
        </div>
      </div>
    </div>`;
}

// ── Налаштування ────────────────────────────────────────────────────────────

async function openSettings() {
  const data = await api("/api/settings");
  state.settings = data.settings;
  $("#setGoal").value = (Number(data.settings.sleep_goal_minutes) / 60).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  $("#setBedtime").value = data.settings.bedtime || "23:00";
  $("#setWake").value = data.settings.wake_reminder || "";
  $("#setWarn").value = data.settings.sleep_warn_nights || 5;
  $("#setStatus").textContent = data.telegram
    ? (data.settings.telegram_chat_id ? "Telegram-бот під'єднаний." : "Токен є — напиши боту /start, щоб він знав, куди слати нагадування.")
    : "Telegram-бот вимкнений: у .env немає TELEGRAM_TOKEN.";
  $("#settingsDialog").showModal();
}

async function saveSettings() {
  await api("/api/settings", {
    method: "PUT",
    body: {
      sleep_goal_minutes: String(Math.round(Number($("#setGoal").value || 8) * 60)),
      bedtime: $("#setBedtime").value || "23:00",
      wake_reminder: $("#setWake").value || "",
      sleep_warn_nights: String($("#setWarn").value || 5),
    },
  });
  $("#settingsDialog").close();
  toast("Збережено");
  refresh();
}

// ── Навігація й події ───────────────────────────────────────────────────────

function showTab(name) {
  state.tab = name;
  $$("#tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["overview", "tasks", "sleep", "food"].forEach((tab) => { $(`#tab-${tab}`).hidden = tab !== name; });
  try { localStorage.setItem("hub_tab", name); } catch (e) { /* байдуже */ }
  refresh();
}

async function refresh() {
  try {
    if (state.tab === "overview") await renderOverview();
    else if (state.tab === "tasks") await renderTasks();
    else if (state.tab === "sleep") await renderSleep();
    else if (state.tab === "food") await renderFood();
  } catch (error) {
    console.error(error);
  }
}

function bind() {
  $("#tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) showTab(button.dataset.tab);
  });

  $("#themeBtn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "latte" ? "mocha" : "latte";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("hub_theme", next); } catch (e) { /* байдуже */ }
  });

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#setSave").addEventListener("click", saveSettings);
  $("#setClose").addEventListener("click", () => $("#settingsDialog").close());

  // Задачі: відмітки, редагування, видалення — і на огляді, і на вкладці.
  document.addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) {
      const row = toggle.closest(".task");
      const completed = !row.classList.contains("done");
      row.classList.toggle("done", completed);
      await api(`/api/tasks/${toggle.dataset.toggle}/toggle`, {
        method: "POST",
        body: { date: state.tab === "tasks" ? state.taskDay : todayISO(), completed },
      });
      refresh();
      return;
    }

    const del = event.target.closest("[data-del]");
    if (del) {
      if (!confirm("Видалити задачу разом з історією?")) return;
      await api(`/api/tasks/${del.dataset.del}`, { method: "DELETE" });
      toast("Видалено");
      refresh();
      return;
    }

    const edit = event.target.closest("[data-edit]");
    if (edit) {
      const row = edit.closest(".task");
      const name = prompt("Нова назва", row.querySelector(".name").childNodes[0].textContent.trim());
      if (name && name.trim()) {
        await api(`/api/tasks/${edit.dataset.edit}`, { method: "PATCH", body: { name: name.trim() } });
        refresh();
      }
      return;
    }

    const chip = event.target.closest("#newTaskDays button");
    if (chip) {
      const day = Number(chip.dataset.day);
      state.newTaskDays.has(day) ? state.newTaskDays.delete(day) : state.newTaskDays.add(day);
      renderDayChips();
      return;
    }

    const tagButton = event.target.closest(".tagbtn[data-tag]");
    if (tagButton) {
      const card = tagButton.closest(".shot");
      const already = tagButton.getAttribute("aria-pressed") === "true";
      await api(`/api/food/${card.dataset.food}`, {
        method: "PATCH",
        body: { tag: already ? "" : tagButton.dataset.tag },
      });
      renderFood();
      return;
    }

    const dropButton = event.target.closest(".tagbtn[data-drop]");
    if (dropButton) {
      if (!confirm("Видалити це фото?")) return;
      await api(`/api/food/${dropButton.closest(".shot").dataset.food}`, { method: "DELETE" });
      renderFood();
      return;
    }

    const star = event.target.closest(".stars button");
    if (star) {
      const line = star.closest("[data-night]");
      await api(`/api/sleep/${line.dataset.night}`, { method: "PUT", body: { quality: Number(star.dataset.q) } });
      renderSleep();
    }
  });

  // Задачі: додавання
  $("#addTask").addEventListener("click", async () => {
    const input = $("#newTaskName");
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    await api("/api/tasks", { method: "POST", body: { name, recurrence_rule: ruleFromForm() } });
    input.value = "";
    toast("Додано");
    refresh();
  });
  $("#newTaskName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#addTask").click();
  });
  $("#newTaskRule").addEventListener("change", () => {
    $("#newTaskDays").hidden = $("#newTaskRule").value !== "days";
  });

  $("#dayPrev").addEventListener("click", () => { state.taskDay = shiftISO(state.taskDay, -1); renderTasks(); });
  $("#dayNext").addEventListener("click", () => { state.taskDay = shiftISO(state.taskDay, 1); renderTasks(); });
  $("#dayToday").addEventListener("click", () => { state.taskDay = todayISO(); renderTasks(); });

  // Сон
  $("#btnBed").addEventListener("click", async () => {
    await api("/api/sleep/bed", { method: "POST" });
    toast("Добраніч 🌙");
    refresh();
  });
  $("#btnWake").addEventListener("click", async () => {
    const result = await api("/api/sleep/wake", { method: "POST" });
    toast(result.night && result.night.duration ? `Сон: ${fmtMinutes(result.night.duration)}` : "Записано");
    refresh();
  });
  $$("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      state.sleepRange = button.dataset.range;
      $$("[data-range]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      renderSleep();
    });
  });
  $("#sleepTable").addEventListener("change", async (event) => {
    const input = event.target.closest("input[data-field]");
    if (!input) return;
    const night = input.closest("[data-night]").dataset.night;
    await api(`/api/sleep/${night}`, { method: "PUT", body: { [input.dataset.field]: input.value } });
    renderSleep();
  });

  // Їжа: ручне завантаження, коли бот не під рукою
  $("#foodUpload").addEventListener("click", () => $("#foodFile").click());
  $("#foodFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("photo", file);
    await api("/api/food/upload", { method: "POST", body: form });
    event.target.value = "";
    toast("Фото додано — постав тег");
    renderFood();
  });
}

// ── Старт ───────────────────────────────────────────────────────────────────

function init() {
  $("#todayLabel").textContent = humanDate(todayISO(), { weekday: "long", day: "numeric", month: "long" });
  renderDayChips();
  bind();
  let saved = "overview";
  try { saved = localStorage.getItem("hub_tab") || "overview"; } catch (e) { /* байдуже */ }
  showTab(["overview", "tasks", "sleep", "food"].includes(saved) ? saved : "overview");
  setInterval(() => { if (state.tab === "overview") renderOverview().catch(() => {}); }, 120000);
}

init();
