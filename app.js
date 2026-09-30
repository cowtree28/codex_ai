const $ = (selector) => document.querySelector(selector);
const STORAGE_KEY = "check-schedules-v1";
const ALERT_KEY = "check-alerts-v1";
const SETTINGS_KEY = "check-settings-v1";
const statuses = [
  { value: "backlog", label: "대기" },
  { value: "todo", label: "할 일" },
  { value: "progress", label: "진행 중" },
  { value: "done", label: "완료" },
  { value: "canceled", label: "취소" },
];
const repeatLabels = { none: "", daily: "매일 반복", weekly: "매주 반복", monthly: "매월 반복" };
const categories = ["공부", "생활", "약속", "기타"];
const statusClasses = statuses.map(({ value }) => `status-${value}`);

function localISO(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function dateFromISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function utcDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function addDays(value, days) {
  const date = dateFromISO(value);
  date.setDate(date.getDate() + days);
  return localISO(date);
}

function formatDay(value) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(dateFromISO(value));
}

function loadItems() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string" && typeof item.title === "string") : [];
  } catch {
    return [];
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { dayBefore: saved.dayBefore === true, night: saved.night === true };
  } catch {
    return { dayBefore: false, night: false };
  }
}

let items = loadItems();
let settings = loadSettings();
let editingId = null;
let selectedDate = localISO();
let calendarCursor = dateFromISO(selectedDate);
calendarCursor.setDate(1);
let recordPeriod = "week";
let currentView = "today";

// 저장에 실패하면 화면에서 이유를 알려준다.
function saveItems() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    return true;
  } catch {
    showFormError("브라우저 저장 공간에 저장하지 못했습니다.");
    return false;
  }
}

function showFormError(message) {
  $("#form-error").textContent = message;
  $("#form-error").hidden = false;
}

function clearFormError() {
  $("#form-error").textContent = "";
  $("#form-error").hidden = true;
}

function resetForm() {
  editingId = null;
  $("#schedule-form").reset();
  $("#form-heading").textContent = "새 일정";
  $("#submit-button").textContent = "추가";
  $("#cancel-edit").hidden = true;
  clearFormError();
}

function startEdit(item) {
  editingId = item.id;
  $("#schedule-title").value = item.title;
  $("#schedule-date").value = item.date || "";
  $("#schedule-time").value = item.time || "";
  $("#schedule-repeat").value = item.repeat || "none";
  $("#schedule-category").value = categories.includes(item.category) ? item.category : "기타";
  $("#schedule-memo").value = item.memo || "";
  $("#form-heading").textContent = "일정 수정";
  $("#submit-button").textContent = "저장";
  $("#cancel-edit").hidden = false;
  clearFormError();
  showPage("today");
  $("#schedule-form").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#schedule-title").focus();
}

// 날짜 계산은 현지 시간의 날짜만 비교해 반복 일정을 만든다.
function occursOn(item, day) {
  if (!item.date || day < item.date) return false;
  if (item.repeat === "daily") return true;
  if (item.repeat === "weekly") {
    return Math.round((utcDay(day) - utcDay(item.date)) / 86400000) % 7 === 0;
  }
  if (item.repeat === "monthly") return Number(day.slice(8)) === Number(item.date.slice(8));
  return day === item.date;
}

function statusOn(item, day) {
  if (item.repeat && item.repeat !== "none" && day) return item.overrides?.[day]?.status || item.status || "backlog";
  return item.status || "backlog";
}

function occurrencesOn(day) {
  return items.filter((item) => occursOn(item, day)).map((item) => ({ item, day, status: statusOn(item, day) }));
}

function todayEntries() {
  const today = localISO();
  const visible = items.flatMap((item) => {
    if (!item.date) return [{ item, day: null, status: statusOn(item, null) }];
    if (occursOn(item, today)) return [{ item, day: today, status: statusOn(item, today) }];
    if ((item.repeat || "none") === "none" && item.date < today && !["done", "canceled"].includes(statusOn(item, item.date))) {
      return [{ item, day: item.date, status: statusOn(item, item.date) }];
    }
    return [];
  });
  return visible.sort((a, b) => {
    const dateOrder = (a.day || "9999").localeCompare(b.day || "9999");
    if (dateOrder) return dateOrder;
    const timeOrder = (a.item.time || "99:99").localeCompare(b.item.time || "99:99");
    return timeOrder || (a.item.createdAt || "").localeCompare(b.item.createdAt || "");
  });
}

function changeStatus(item, day, status) {
  const previous = JSON.stringify(item);
  if ((item.repeat || "none") !== "none" && day) {
    item.overrides ||= {};
    item.overrides[day] = { status, completedAt: status === "done" ? new Date().toISOString() : null };
  } else {
    item.status = status;
    item.completedAt = status === "done" ? new Date().toISOString() : null;
  }
  item.updatedAt = new Date().toISOString();
  if (!saveItems()) Object.assign(item, JSON.parse(previous));
  renderAll();
}

function deleteItem(item) {
  if (item.repeat !== "none" && !window.confirm("이 반복 일정 전체를 삭제할까요?")) return;
  const previous = items;
  items = items.filter((candidate) => candidate.id !== item.id);
  if (!saveItems()) items = previous;
  if (editingId === item.id) resetForm();
  renderAll();
}

function makeEntry(entry) {
  const { item, day, status } = entry;
  const row = document.createElement("li");
  row.className = `schedule-item status-${status}`;

  const sourceIcon = document.createElement("span");
  sourceIcon.className = "source-icon";
  sourceIcon.textContent = item.repeat && item.repeat !== "none" ? "↻" : "•";
  sourceIcon.setAttribute("aria-label", item.repeat && item.repeat !== "none" ? "반복 일정" : "직접 추가");

  const select = document.createElement("select");
  select.className = "schedule-status";
  select.setAttribute("aria-label", `${item.title} 상태`);
  statuses.forEach(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  });
  select.value = status;
  select.addEventListener("change", () => changeStatus(item, day, select.value));

  const details = document.createElement("div");
  details.className = "schedule-details";
  const title = document.createElement("span");
  title.className = "schedule-title";
  title.textContent = item.title;
  const meta = document.createElement("small");
  meta.className = "schedule-meta";
  meta.textContent = [day ? formatDay(day) : "날짜 없음", item.time || "", item.category || "기타", repeatLabels[item.repeat] || "직접 추가"].filter(Boolean).join(" · ");
  details.append(title, meta);
  if (item.memo) {
    const memo = document.createElement("span");
    memo.className = "schedule-memo";
    memo.textContent = item.memo;
    details.append(memo);
  }

  const edit = document.createElement("button");
  edit.className = "text-button";
  edit.type = "button";
  edit.textContent = "수정";
  edit.setAttribute("aria-label", `${item.title} 수정`);
  edit.addEventListener("click", () => startEdit(item));

  const remove = document.createElement("button");
  remove.className = "delete-button";
  remove.type = "button";
  remove.textContent = "삭제";
  remove.setAttribute("aria-label", `${item.title} 삭제`);
  remove.addEventListener("click", () => deleteItem(item));

  row.append(sourceIcon, select, details, edit, remove);
  return row;
}

function renderToday() {
  const today = localISO();
  $("#today-date").textContent = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(dateFromISO(today));
  $("#today-date").dateTime = today;
  const entries = todayEntries();
  const remaining = entries.filter(({ status }) => !["done", "canceled"].includes(status)).length;
  $("#today-remaining").textContent = `${remaining}개`;
  $("#total-count").textContent = `${items.length}개`;
  $("#done-count-summary").textContent = `${entries.filter(({ status }) => status === "done").length}개`;
  $("#schedule-count").textContent = `${entries.length}개`;
  $("#empty-message").hidden = entries.length > 0;
  $("#graph-empty-message").hidden = entries.length > 0;
  $("#graph-content").hidden = entries.length === 0;
  $("#schedule-list").replaceChildren(...entries.map(makeEntry));
  statuses.forEach(({ value }) => {
    const count = entries.filter(({ status }) => status === value).length;
    $(`#${value}-count`).textContent = `${count}개`;
    $(`#${value}-bar`).style.width = entries.length ? `${(count / entries.length) * 100}%` : "0%";
  });
}

function renderSelectedDay() {
  $("#selected-day-heading").textContent = `${formatDay(selectedDate)} 일정`;
  const entries = occurrencesOn(selectedDate).sort((a, b) => (a.item.time || "99:99").localeCompare(b.item.time || "99:99"));
  $("#selected-day-empty").hidden = entries.length > 0;
  $("#selected-day-list").replaceChildren(...entries.map(makeEntry));
}

function renderCalendar() {
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  $("#calendar-month").textContent = `${year}년 ${month + 1}월`;
  const grid = $("#calendar-grid");
  grid.replaceChildren();
  const offset = new Date(year, month, 1).getDay();
  const lastDay = new Date(year, month + 1, 0).getDate();
  for (let index = 0; index < offset; index += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-blank";
    grid.append(blank);
  }
  for (let day = 1; day <= lastDay; day += 1) {
    const iso = localISO(new Date(year, month, day));
    const count = occurrencesOn(iso).length;
    const button = document.createElement("button");
    button.className = "calendar-day";
    button.type = "button";
    button.setAttribute("aria-label", `${formatDay(iso)} 일정 ${count}개`);
    if (iso === localISO()) button.classList.add("is-today");
    if (iso === selectedDate) button.classList.add("is-selected");
    const number = document.createElement("span");
    number.textContent = String(day);
    button.append(number);
    if (count) {
      const badge = document.createElement("small");
      badge.textContent = `${count}개`;
      button.append(badge);
    }
    button.addEventListener("click", () => { selectedDate = iso; renderCalendar(); });
    grid.append(button);
  }
  renderSelectedDay();
}

function completedRecords() {
  const records = [];
  items.forEach((item) => {
    Object.values(item.overrides || {}).forEach((override) => {
      if (override.status === "done" && override.completedAt) records.push({ title: item.title, category: item.category || "기타", day: localISO(new Date(override.completedAt)) });
    });
    if (item.status === "done" && item.completedAt) {
      records.push({ title: item.title, category: item.category || "기타", day: localISO(new Date(item.completedAt)) });
    }
  });
  return records;
}

function renderRecords() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (recordPeriod === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  else start.setDate(1);
  const days = recordPeriod === "week" ? 7 : new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dates = Array.from({ length: days }, (_, index) => localISO(new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)));
  const records = completedRecords().filter(({ day }) => dates.includes(day));
  $("#record-total").textContent = `${records.length}개`;
  const categoryParts = categories.map((category) => ({ category, count: records.filter((record) => record.category === category).length })).filter(({ count }) => count > 0);
  $("#record-line").textContent = categoryParts.length ? `이번 ${recordPeriod === "week" ? "주" : "달"}에는 ${categoryParts.map(({ category, count }) => `${category} ${count}개`).join(", ")}를 마쳤습니다.` : "아직 완료한 일정이 없습니다.";
  const timeline = $("#timeline-graph");
  timeline.replaceChildren();
  const max = Math.max(1, ...dates.map((day) => records.filter((record) => record.day === day).length));
  dates.forEach((day) => {
    const done = records.filter((record) => record.day === day);
    const row = document.createElement("div");
    row.className = "timeline-row";
    const label = document.createElement("span");
    label.textContent = formatDay(day);
    const track = document.createElement("div");
    track.className = "graph-track";
    const bar = document.createElement("div");
    bar.className = "graph-bar done-bar";
    bar.style.width = `${(done.length / max) * 100}%`;
    track.append(bar);
    const count = document.createElement("strong");
    count.textContent = `${done.length}개`;
    row.append(label, track, count);
    if (done.length) {
      const titles = document.createElement("small");
      titles.textContent = done.map((record) => record.title).join(" · ");
      row.append(titles);
    }
    timeline.append(row);
  });
  const categoryGraph = $("#category-graph");
  categoryGraph.replaceChildren();
  categories.forEach((category) => {
    const count = records.filter((record) => record.category === category).length;
    const row = document.createElement("div");
    row.className = "graph-row";
    const label = document.createElement("span");
    label.textContent = category;
    const track = document.createElement("div");
    track.className = "graph-track";
    const bar = document.createElement("div");
    bar.className = "graph-bar category-bar";
    bar.style.width = records.length ? `${(count / records.length) * 100}%` : "0%";
    track.append(bar);
    const value = document.createElement("strong");
    value.textContent = records.length ? `${Math.round((count / records.length) * 100)}%` : "0%";
    row.append(label, track, value);
    categoryGraph.append(row);
  });
}

function renderSettings() {
  $("#day-before-option").checked = settings.dayBefore;
  $("#night-option").checked = settings.night;
  if (!("Notification" in window)) {
    $("#notification-button").disabled = true;
    $("#notification-status").textContent = "이 브라우저는 알림을 지원하지 않습니다.";
  } else {
    $("#notification-button").disabled = Notification.permission === "granted";
    $("#notification-status").textContent = Notification.permission === "granted" ? "알림이 허용되었습니다." : Notification.permission === "denied" ? "브라우저 설정에서 알림 권한을 바꿔 주세요." : "알림 권한을 허용하면 안내를 받을 수 있습니다.";
  }
}

function renderAll() {
  renderToday();
  renderCalendar();
  renderRecords();
  renderSettings();
}

function showPage(view) {
  currentView = view;
  const names = { today: "오늘", calendar: "캘린더", records: "기록", settings: "설정" };
  $("#topbar-title").textContent = names[view];
  document.querySelectorAll(".page-view").forEach((page) => { page.hidden = page.id !== `${view}-view`; });
  document.querySelectorAll(".nav-item").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

// 제목과 날짜를 확인하고 일정 하나를 추가하거나 수정한다.
$("#schedule-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearFormError();
  const title = $("#schedule-title").value.trim();
  const date = $("#schedule-date").value || null;
  const time = $("#schedule-time").value;
  const repeat = $("#schedule-repeat").value;
  if (!title) return showFormError("일정 제목을 입력해 주세요.");
  if (time && !date) return showFormError("시간을 정하려면 날짜를 선택해 주세요.");
  if (repeat !== "none" && !date) return showFormError("반복 일정을 만들려면 날짜를 선택해 주세요.");
  const duplicate = items.some((item) => item.id !== editingId && item.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase() && item.date === date && (item.time || "") === time);
  if (duplicate) return showFormError("같은 제목과 날짜·시간의 일정이 이미 있습니다.");
  const existing = items.find((item) => item.id === editingId);
  const before = existing ? JSON.stringify(existing) : null;
  const now = new Date().toISOString();
  if (existing) {
    const wasRepeating = existing.repeat && existing.repeat !== "none";
    const oldDate = existing.date;
    const oldStatus = existing.status;
    const oldCompletedAt = existing.completedAt;
    Object.assign(existing, { title, date, time, repeat, category: $("#schedule-category").value, memo: $("#schedule-memo").value.trim(), updatedAt: now });
    if (!wasRepeating && repeat !== "none") {
      // 한 번짜리 일정의 완료 기록은 첫 반복 날짜에 남긴다.
      if (oldStatus !== "backlog") {
        existing.overrides ||= {};
        existing.overrides[oldDate || date] = { status: oldStatus, completedAt: oldCompletedAt };
      }
      existing.status = "backlog";
      existing.completedAt = null;
    } else if (wasRepeating && repeat === "none") {
      // 반복을 해제하면 선택한 날짜의 상태를 일반 일정으로 옮긴다.
      const occurrence = existing.overrides?.[date];
      existing.status = occurrence?.status || "backlog";
      existing.completedAt = occurrence?.completedAt || null;
      if (occurrence) delete existing.overrides[date];
    }
  } else {
    items.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, date, time, repeat, category: $("#schedule-category").value, memo: $("#schedule-memo").value.trim(), status: "backlog", completedAt: null, overrides: {}, createdAt: now, updatedAt: now });
  }
  if (!saveItems()) {
    if (existing) Object.assign(existing, JSON.parse(before));
    else items.pop();
    return;
  }
  resetForm();
  renderAll();
  if (date && date > localISO()) {
    selectedDate = date;
    calendarCursor = dateFromISO(date);
    calendarCursor.setDate(1);
    renderCalendar();
    showPage("calendar");
  }
});

$("#cancel-edit").addEventListener("click", resetForm);
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.view)));
$("#previous-month").addEventListener("click", () => { calendarCursor.setMonth(calendarCursor.getMonth() - 1); selectedDate = localISO(calendarCursor); renderCalendar(); });
$("#next-month").addEventListener("click", () => { calendarCursor.setMonth(calendarCursor.getMonth() + 1); selectedDate = localISO(calendarCursor); renderCalendar(); });
$("#week-button").addEventListener("click", () => changePeriod("week"));
$("#month-button").addEventListener("click", () => changePeriod("month"));
function changePeriod(period) {
  recordPeriod = period;
  ["week", "month"].forEach((name) => {
    const active = name === period;
    $(`#${name}-button`).classList.toggle("is-active", active);
    $(`#${name}-button`).setAttribute("aria-pressed", String(active));
  });
  renderRecords();
}
$("#list-view-button").addEventListener("click", () => showListMode(true));
$("#graph-view-button").addEventListener("click", () => showListMode(false));
function showListMode(showList) {
  $("#list-view").hidden = !showList;
  $("#graph-view").hidden = showList;
  $("#list-view-button").classList.toggle("is-active", showList);
  $("#graph-view-button").classList.toggle("is-active", !showList);
  $("#list-view-button").setAttribute("aria-pressed", String(showList));
  $("#graph-view-button").setAttribute("aria-pressed", String(!showList));
}

$("#notification-button").addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  try { await Notification.requestPermission(); }
  catch { $("#notification-status").textContent = "알림 권한을 요청하지 못했습니다."; return; }
  renderSettings();
});
function saveSettings() {
  settings = { dayBefore: $("#day-before-option").checked, night: $("#night-option").checked };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch { $("#notification-status").textContent = "알림 설정을 저장하지 못했습니다."; }
}
$("#day-before-option").addEventListener("change", saveSettings);
$("#night-option").addEventListener("change", saveSettings);

function notifyOnce(key, title, body) {
  let sent = [];
  try { sent = JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"); } catch { sent = []; }
  if (!Array.isArray(sent)) sent = [];
  if (sent.includes(key)) return;
  try { new Notification(title, { body }); }
  catch { return; }
  try { localStorage.setItem(ALERT_KEY, JSON.stringify([...sent.slice(-299), key])); } catch { /* 알림은 이미 표시되었다. */ }
}

// 브라우저가 열려 있을 때만 정해진 시간의 알림을 확인한다.
function checkNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  const today = localISO(now);
  const minutes = now.getHours() * 60 + now.getMinutes();
  const todayOpen = todayEntries().filter(({ status }) => !["done", "canceled"].includes(status));
  if (minutes >= 480 && minutes < 540) notifyOnce(`summary-${today}`, "오늘 일정", `남은 일정 ${todayOpen.length}개가 있습니다.`);
  for (const day of [today, addDays(today, 1)]) {
    occurrencesOn(day).filter(({ item, status }) => item.time && !["done", "canceled"].includes(status)).forEach(({ item }) => {
      const [hour, minute] = item.time.split(":").map(Number);
      const due = dateFromISO(day);
      due.setHours(hour, minute, 0, 0);
      for (const before of [60, 10]) {
        const trigger = due.getTime() - before * 60000;
        const end = before === 60 ? due.getTime() - 10 * 60000 : due.getTime();
        const remaining = Math.ceil((due.getTime() - now.getTime()) / 60000);
        if (now.getTime() >= trigger && now.getTime() < end) notifyOnce(`${item.id}-${day}-${before}`, "일정 알림", `${remaining}분 뒤 ${item.title} 일정이 있습니다.`);
      }
    });
  }
  if (settings.dayBefore && minutes >= 1200 && minutes < 1260) {
    const tomorrow = addDays(today, 1);
    const count = occurrencesOn(tomorrow).filter(({ status }) => !["done", "canceled"].includes(status)).length;
    if (count) notifyOnce(`day-before-${today}`, "내일 일정", `내일 일정 ${count}개가 있습니다.`);
  }
  if (settings.night && minutes >= 1260 && minutes < 1320 && todayOpen.length) notifyOnce(`night-${today}`, "미완료 일정", `오늘 남은 일정 ${todayOpen.length}개가 있습니다.`);
}

renderAll();
checkNotifications();
setInterval(() => { if (currentView === "today" && $("#today-date").dateTime !== localISO()) renderAll(); checkNotifications(); }, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { renderAll(); checkNotifications(); } });
