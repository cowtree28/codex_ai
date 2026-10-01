export const STORAGE_KEY = "study-planner-items";
export const LEGACY_STORAGE_KEY = "check-schedules-v1";
export const SETTINGS_KEY = "check-settings-v1";
export const ALERT_KEY = "check-alerts-v1";
export const statuses = [
  { value: "backlog", label: "대기" },
  { value: "todo", label: "할 일" },
  { value: "progress", label: "진행 중" },
  { value: "done", label: "완료" },
  { value: "canceled", label: "취소" },
];
export const categories = ["공부", "생활", "약속", "기타"];
export const repeatLabels = { none: "", daily: "매일 반복", weekly: "매주 반복", monthly: "매월 반복" };

export function localISO(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}
export function dateFromISO(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}
function utcDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}
export function addDays(value, days) {
  const date = dateFromISO(value);
  date.setDate(date.getDate() + days);
  return localISO(date);
}
export function formatDay(value) {
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "short" }).format(dateFromISO(value));
}
export function parseItems(raw) {
  const saved = JSON.parse(raw);
  return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string" && typeof item.title === "string") : [];
}
export function loadItems() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current !== null) return parseItems(current);
    // 같은 출처에 남은 이전 저장 키를 한 번만 옮긴다.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === null) return [];
    const migrated = parseItems(legacy);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch { /* 읽은 일정은 화면에 그대로 보여준다. */ }
    return migrated;
  } catch { return []; }
}
export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return { dayBefore: saved.dayBefore === true, night: saved.night === true };
  } catch { return { dayBefore: false, night: false }; }
}
export function occursOn(item, day) {
  if (!item.date || day < item.date) return false;
  if (item.repeat === "daily") return true;
  if (item.repeat === "weekly") {
    return Math.round((utcDay(day) - utcDay(item.date)) / 86400000) % 7 === 0;
  }
  if (item.repeat === "monthly") return Number(day.slice(8)) === Number(item.date.slice(8));
  return day === item.date;
}
export function statusOn(item, day) {
  if (item.repeat && item.repeat !== "none" && day) return item.overrides?.[day]?.status || item.status || "backlog";
  return item.status || "backlog";
}
export function occurrencesOn(items, day) {
  return items.filter((item) => occursOn(item, day)).map((item) => ({ item, day, status: statusOn(item, day) }));
}
export function todayEntries(items, today) {
  return items.flatMap((item) => {
    if (!item.date) return [{ item, day: null, status: statusOn(item, null) }];
    if (occursOn(item, today)) return [{ item, day: today, status: statusOn(item, today) }];
    if ((item.repeat || "none") === "none" && item.date < today && !["done", "canceled"].includes(statusOn(item, item.date))) return [{ item, day: item.date, status: statusOn(item, item.date) }];
    return [];
  }).sort((a, b) => (a.day || "9999").localeCompare(b.day || "9999") || (a.item.time || "99:99").localeCompare(b.item.time || "99:99") || (a.item.createdAt || "").localeCompare(b.item.createdAt || ""));
}
export function completedRecords(items) {
  return items.flatMap((item) => {
    const records = Object.values(item.overrides || {}).filter((override) => override.status === "done" && override.completedAt).map((override) => ({ title: item.title, category: item.category || "기타", day: localISO(new Date(override.completedAt)) }));
    if (item.status === "done" && item.completedAt) records.push({ title: item.title, category: item.category || "기타", day: localISO(new Date(item.completedAt)) });
    return records;
  });
}
