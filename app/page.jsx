"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, clearToken, getToken, setToken } from "./api";
import IntegrationsPanel from "./IntegrationsPanel";
import WikiView from "./WikiView";
import { ALERT_KEY, addDays, categories, completedRecords, dateFromISO, formatDay, loadItems, loadSettings, localISO, occurrencesOn, repeatLabels, statuses, todayEntries } from "./planner";

const emptyForm = { title: "", memo: "", date: "", time: "", repeat: "none", category: "공부" };
const viewNames = { today: "오늘", calendar: "캘린더", records: "기록", wiki: "위키", settings: "설정" };
const sourceLabels = { gmail: "메일", discord: "디스코드" };
const icons = {
  today: <><path d="M4 5.5h16v13H4zM8 3.5v4M16 3.5v4M4 9.5h16" /><path d="m9 14 2 2 4-4" /></>,
  calendar: <><path d="M4 5.5h16v14H4zM8 3.5v4M16 3.5v4M4 9.5h16M8 13h2M14 13h2M8 16.5h2" /></>,
  records: <><path d="M5 4.5h14v15H5zM8.5 9h7M8.5 12.5h7M8.5 16h4" /></>,
  wiki: <><path d="M6 3.5h9l3 3v14H6z" /><path d="M9 10h6M9 13.5h6M9 17h3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></>,
};

function Entry({ entry, onStatus, onEdit, onDelete, onNote }) {
  const { item, day, status } = entry;
  const meta = [day ? formatDay(day) : "날짜 없음", item.time, item.category || "기타", repeatLabels[item.repeat], sourceLabels[item.source]].filter(Boolean);
  const sourceName = sourceLabels[item.source] ? `${sourceLabels[item.source]}에서 자동 추가` : item.repeat && item.repeat !== "none" ? "반복 일정" : "직접 추가";
  return <li className={`schedule-item status-${status}`}>
    <span className="source-icon" aria-label={sourceName} title={item.sourceRef || sourceName}>{item.source === "gmail" ? "✉" : item.source === "discord" ? "#" : item.repeat && item.repeat !== "none" ? "↻" : "•"}</span>
    <select className="schedule-status" aria-label={`${item.title} 상태`} value={status} onChange={(event) => onStatus(item, day, event.target.value)}>{statuses.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select>
    <div className="schedule-details"><span className="schedule-title">{item.title}</span><small className="schedule-meta">{meta.map((value, index) => <span className="meta-token" key={`${value}-${index}`}>{value}</span>)}</small>{item.memo && <span className="schedule-memo">{item.memo}</span>}</div>
    {onNote && <button className="text-button" type="button" aria-label={`${item.title} 위키에 기록`} onClick={() => onNote(item)}>위키</button>}<button className="text-button" type="button" aria-label={`${item.title} 수정`} onClick={() => onEdit(item)}>수정</button>
    <button className="delete-button" type="button" aria-label={`${item.title} 삭제`} onClick={() => onDelete(item)}>삭제</button>
  </li>;
}

function GraphRow({ label, count, total, barClass, percent }) {
  return <div className="graph-row"><span>{label}</span><div className="graph-track"><div className={`graph-bar ${barClass}`} style={{ width: `${total ? count / total * 100 : 0}%` }} /></div><strong>{percent ? `${total ? Math.round(count / total * 100) : 0}%` : `${count}개`}</strong></div>;
}

export default function Planner() {
  const [items, setItems] = useState([]);
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState("checking"); // checking | login | ok
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [wikiRequest, setWikiRequest] = useState(null); // 일정을 위키에 기록할 때 {title, text}
  const [settings, setSettings] = useState({ dayBefore: false, night: false });
  const [permission, setPermission] = useState("default");
  const [settingError, setSettingError] = useState("");
  const [view, setView] = useState("today");
  const [query, setQuery] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [formError, setFormError] = useState("");
  const [filter, setFilter] = useState("all");
  const [listMode, setListMode] = useState(true);
  const [today, setToday] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [calendarMonth, setCalendarMonth] = useState("");
  const [recordPeriod, setRecordPeriod] = useState("week");
  const titleRef = useRef(null);
  const formRef = useRef(null);

  useEffect(() => {
    const now = localISO();
    setToday(now);
    setSelectedDate(now);
    setCalendarMonth(now.slice(0, 7));
    setPermission("Notification" in window ? Notification.permission : "unsupported");
    if (getToken()) loadFromServer(); else { setAuth("login"); setReady(true); }
  }, []);

  // 서버에서 일정과 설정을 읽는다. 서버가 비어 있고 이 브라우저에 예전 일정이 있으면 한 번 올린다.
  async function loadFromServer() {
    setSyncError("");
    try {
      let [serverItems, serverSettings] = await Promise.all([api.items(), api.settings()]);
      if (serverItems.length === 0) {
        const local = loadItems();
        if (local.length) { await api.saveItems(local); serverItems = local; }
      }
      if (Object.keys(serverSettings).length === 0) {
        const local = loadSettings();
        if (local.dayBefore || local.night) { await api.saveSettings(local); serverSettings = local; }
      }
      setItems(serverItems);
      setSettings({ dayBefore: serverSettings.dayBefore === true, night: serverSettings.night === true });
      setAuth("ok");
    } catch (error) {
      if (error.status === 401) { clearToken(); setAuth("login"); }
      else setSyncError(error.message);
    }
    setReady(true);
  }
  async function submitLogin(event) {
    event.preventDefault();
    if (!password) { setLoginError("비밀번호를 입력해 주세요."); return; }
    setLoginBusy(true); setLoginError("");
    try {
      const { token } = await api.login(password);
      setToken(token); setPassword("");
      await loadFromServer();
    } catch (error) { setLoginError(error.message); }
    setLoginBusy(false);
  }
  function logout() { clearToken(); setItems([]); setAuth("login"); }
  function authLost() { clearToken(); setAuth("login"); }
  // 서버가 메일·디스코드에서 추가한 일정을 다시 읽는다. 일정을 고치는 중이면 건너뛴다.
  async function reloadItems() {
    try { setItems(await api.items()); } catch (error) { if (error.status === 401) authLost(); }
  }
  function openItemNote(item) {
    const when = [item.date, item.time].filter(Boolean).join(" ");
    setWikiRequest({ title: item.title, text: `일정: ${item.title}${when ? ` (${when})` : ""}\n카테고리: ${item.category || "기타"}${item.memo ? `\n메모: ${item.memo}` : ""}\n` });
    setView("wiki");
  }
  function markReviewed(ids) {
    const now = new Date().toISOString();
    commitItems(items.map((item) => ids.includes(item.id) ? { ...item, aiReviewed: true, updatedAt: now } : item));
  }

  // 화면을 먼저 바꾸고 서버에 저장한다. 실패하면 안내를 띄운다.
  function commitItems(next) {
    setItems(next); setSyncError("");
    api.saveItems(next).catch((error) => {
      if (error.status === 401) { clearToken(); setAuth("login"); }
      else setSyncError(`서버에 저장하지 못했습니다. ${error.message}`);
    });
    return true;
  }
  function resetForm() { setForm(emptyForm); setEditingId(null); setDetailsOpen(false); setFormError(""); }
  function startEdit(item) {
    setForm({ title: item.title, memo: item.memo || "", date: item.date || "", time: item.time || "", repeat: item.repeat || "none", category: categories.includes(item.category) ? item.category : "기타" });
    setEditingId(item.id); setDetailsOpen(true); setFormError(""); setView("today");
    requestAnimationFrame(() => { formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); titleRef.current?.focus(); });
  }
  function changeStatus(item, day, status) {
    const now = new Date().toISOString();
    const next = items.map((candidate) => {
      if (candidate.id !== item.id) return candidate;
      if ((candidate.repeat || "none") !== "none" && day) return { ...candidate, overrides: { ...candidate.overrides, [day]: { status, completedAt: status === "done" ? now : null } }, updatedAt: now };
      return { ...candidate, status, completedAt: status === "done" ? now : null, updatedAt: now };
    });
    commitItems(next);
  }
  function deleteItem(item) {
    if ((item.repeat || "none") !== "none" && !window.confirm("이 반복 일정 전체를 삭제할까요?")) return;
    if (commitItems(items.filter((candidate) => candidate.id !== item.id)) && editingId === item.id) resetForm();
  }
  function submitForm(event) {
    event.preventDefault(); setFormError("");
    const title = form.title.trim(), date = form.date || null, time = form.time, repeat = form.repeat;
    if (!title) return setFormError("일정 제목을 입력해 주세요.");
    if (time && !date) return setFormError("시간을 정하려면 날짜를 선택해 주세요.");
    if (repeat !== "none" && !date) return setFormError("반복 일정을 만들려면 날짜를 선택해 주세요.");
    if (items.some((item) => item.id !== editingId && item.title.trim().toLocaleLowerCase() === title.toLocaleLowerCase() && item.date === date && (item.time || "") === time)) return setFormError("같은 제목과 날짜·시간의 일정이 이미 있습니다.");
    const existing = items.find((item) => item.id === editingId);
    const now = new Date().toISOString();
    let next;
    if (existing) {
      let updated = { ...existing, title, date, time, repeat, category: form.category, memo: form.memo.trim(), updatedAt: now };
      const wasRepeating = existing.repeat && existing.repeat !== "none";
      if (!wasRepeating && repeat !== "none") {
        // 일반 일정의 상태를 첫 반복 날짜에 보존한다.
        if (existing.status !== "backlog") updated.overrides = { ...existing.overrides, [existing.date || date]: { status: existing.status, completedAt: existing.completedAt } };
        updated.status = "backlog"; updated.completedAt = null;
      } else if (wasRepeating && repeat === "none") {
        const occurrence = existing.overrides?.[date];
        updated.status = occurrence?.status || "backlog"; updated.completedAt = occurrence?.completedAt || null;
        if (occurrence) { updated.overrides = { ...existing.overrides }; delete updated.overrides[date]; }
      }
      next = items.map((item) => item.id === editingId ? updated : item);
    } else {
      next = [...items, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, date, time, repeat, category: form.category, memo: form.memo.trim(), status: "backlog", completedAt: null, overrides: {}, createdAt: now, updatedAt: now }];
    }
    if (!commitItems(next)) return;
    resetForm();
    if (date && date > localISO()) { setSelectedDate(date); setCalendarMonth(date.slice(0, 7)); setView("calendar"); }
  }
  function saveSettings(next) {
    setSettings(next); setSettingError("");
    api.saveSettings(next).catch((error) => setSettingError(`알림 설정을 저장하지 못했습니다. ${error.message}`));
  }
  async function requestNotifications() {
    if (!("Notification" in window)) return;
    try { setPermission(await Notification.requestPermission()); }
    catch { setSettingError("알림 권한을 요청하지 못했습니다."); }
  }

  const entries = useMemo(() => today ? todayEntries(items, today) : [], [items, today]);
  const visibleEntries = filter === "all" ? entries : entries.filter((entry) => entry.status === filter);
  const recent = [...items].filter((item) => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "")).slice(0, 6);
  const dayEntries = selectedDate ? occurrencesOn(items, selectedDate).sort((a, b) => (a.item.time || "99:99").localeCompare(b.item.time || "99:99")) : [];
  const calendarYear = Number(calendarMonth.slice(0, 4)) || 2000;
  const calendarIndex = Number(calendarMonth.slice(5, 7)) - 1 || 0;
  const monthOffset = new Date(calendarYear, calendarIndex, 1).getDay();
  const monthLength = new Date(calendarYear, calendarIndex + 1, 0).getDate();
  const now = today ? dateFromISO(today) : new Date(2000, 0, 1);
  const recordStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (recordPeriod === "week") recordStart.setDate(recordStart.getDate() - ((recordStart.getDay() + 6) % 7));
  else recordStart.setDate(1);
  const recordDays = recordPeriod === "week" ? 7 : new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const recordDates = Array.from({ length: recordDays }, (_, index) => localISO(new Date(recordStart.getFullYear(), recordStart.getMonth(), recordStart.getDate() + index)));
  const records = completedRecords(items).filter(({ day }) => recordDates.includes(day));
  const maxRecords = Math.max(1, ...recordDates.map((day) => records.filter((record) => record.day === day).length));

  // 알림 확인은 브라우저가 열려 있는 동안에만 반복한다.
  useEffect(() => {
    if (!ready) return;
    function notifyOnce(key, title, body) {
      let sent;
      try { sent = JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"); } catch { sent = []; }
      if (!Array.isArray(sent)) sent = [];
      if (sent.includes(key)) return;
      try { new Notification(title, { body }); } catch { return; }
      try { localStorage.setItem(ALERT_KEY, JSON.stringify([...sent.slice(-299), key])); } catch { /* 알림은 이미 표시되었다. */ }
    }
    function check() {
      setToday(localISO());
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      const current = new Date(), day = localISO(current), minutes = current.getHours() * 60 + current.getMinutes();
      const open = todayEntries(items, day).filter(({ status }) => !["done", "canceled"].includes(status));
      if (minutes >= 480 && minutes < 540) notifyOnce(`summary-${day}`, "오늘 일정", `남은 일정 ${open.length}개가 있습니다.`);
      for (const dueDay of [day, addDays(day, 1)]) {
        occurrencesOn(items, dueDay).filter(({ item, status }) => item.time && !["done", "canceled"].includes(status)).forEach(({ item }) => {
          const [hour, minute] = item.time.split(":").map(Number), due = dateFromISO(dueDay);
          due.setHours(hour, minute, 0, 0);
          for (const before of [60, 10]) {
            const remaining = Math.ceil((due.getTime() - current.getTime()) / 60000);
            if (current.getTime() >= due.getTime() - before * 60000 && current.getTime() < due.getTime() - (before === 60 ? 10 : 0) * 60000) notifyOnce(`${item.id}-${dueDay}-${before}`, "일정 알림", `${remaining}분 뒤 ${item.title} 일정이 있습니다.`);
          }
        });
      }
      if (settings.dayBefore && minutes >= 1200 && minutes < 1260) {
        const count = occurrencesOn(items, addDays(day, 1)).filter(({ status }) => !["done", "canceled"].includes(status)).length;
        if (count) notifyOnce(`day-before-${day}`, "내일 일정", `내일 일정 ${count}개가 있습니다.`);
      }
      if (settings.night && minutes >= 1260 && minutes < 1320 && open.length) notifyOnce(`night-${day}`, "미완료 일정", `오늘 남은 일정 ${open.length}개가 있습니다.`);
    }
    check();
    const interval = setInterval(check, 30000);
    const onVisible = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [ready, items, settings]);

  useEffect(() => {
    if (auth !== "ok") return undefined;
    const tick = () => { if (!document.hidden && !editingId) reloadItems(); };
    const timer = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [auth, editingId]);
  const aiNew = items.filter((item) => item.aiAdded && !item.aiReviewed);
  function moveMonth(direction) {
    const shifted = new Date(calendarYear, calendarIndex + direction, 1);
    const value = localISO(shifted);
    setCalendarMonth(value.slice(0, 7)); setSelectedDate(value);
  }
  if (auth !== "ok") {
    return <main className="login-shell">
      <form className="login-card" onSubmit={submitLogin} aria-busy={loginBusy}>
        <div className="brand"><span className="brand-mark" aria-hidden="true">✓</span><span>check</span></div>
        <h1>내 일정에 들어가기</h1>
        <p className="login-help">이 앱은 한 사람만 씁니다. 서버에 정해 둔 비밀번호를 입력하세요.</p>
        {auth === "checking" ? <p className="login-status" aria-live="polite">{syncError || "서버에서 일정을 불러오는 중…"}</p> : <>
          <label className="login-field"><span>비밀번호</span><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
          <button className="add-button" type="submit" disabled={loginBusy}>{loginBusy ? "확인 중…" : "들어가기"}</button>
          <p className="login-status" role="alert">{loginError || syncError}</p>
        </>}
        {auth === "checking" && syncError && <button className="text-button" type="button" onClick={loadFromServer}>다시 시도</button>}
      </form>
    </main>;
  }
  return <main className="app-shell">
    <aside className="sidebar" aria-label="앱 탐색">
      <div className="brand"><span className="brand-mark" aria-hidden="true">✓</span><span>check</span></div>
      <button className="quick-add" type="button" onClick={() => { resetForm(); setView("today"); requestAnimationFrame(() => titleRef.current?.focus()); }}><span className="quick-add-icon" aria-hidden="true">＋</span>새 일정</button>
      <p className="sidebar-label">작업 공간</p>
      <nav className="main-nav" aria-label="주 메뉴">{Object.entries(viewNames).map(([key, label]) => <button key={key} className={`nav-item ${view === key ? "is-active" : ""}`} type="button" aria-current={view === key ? "page" : undefined} onClick={() => setView(key)}><span aria-hidden="true"><svg viewBox="0 0 24 24">{icons[key]}</svg></span>{label}</button>)}</nav>
      <label className="sidebar-search" htmlFor="sidebar-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg><input id="sidebar-search" type="search" placeholder="일정 검색" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <p className="sidebar-label recent-label">{query.trim() ? "검색 결과" : "최근 일정"}</p>
      <div className="recent-items" aria-live="polite">{recent.length ? recent.map((item) => <button className="recent-item" type="button" key={item.id} onClick={() => startEdit(item)}>{item.title}</button>) : <p className="recent-empty">{query.trim() ? "검색 결과 없음" : "일정 없음"}</p>}</div>
    </aside>
    <div className="workspace"><div className="topbar"><span>내 일정</span><span className="topbar-divider" aria-hidden="true">/</span><strong>{viewNames[view]}</strong>{syncError && <span className="sync-error" role="alert">{syncError}</span>}</div><div className="content">
      <section id="today-view" className="page-view" aria-labelledby="today-heading" hidden={view !== "today"}>
        <header className="page-header"><div className="header-row"><h1 id="today-heading">오늘 일정</h1><time dateTime={today}>{today && new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(dateFromISO(today))}</time></div></header>
        <section className="schedule-panel" aria-labelledby="schedule-heading"><h2 id="schedule-heading" className="visually-hidden">일정 관리</h2>
          <form ref={formRef} className={`schedule-form ${editingId ? "is-editing" : ""}`} onSubmit={submitForm}>
            <div className="form-heading"><h3>{editingId ? "일정 수정" : "새 일정"}</h3><button className="text-button" type="button" hidden={!editingId} onClick={resetForm}>수정 취소</button></div>
            <div className="form-grid"><label className="field field-wide" htmlFor="schedule-title"><span className="field-label">제목</span><input ref={titleRef} id="schedule-title" type="text" placeholder="할 일 제목" autoComplete="off" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
              <details className="form-more" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}><summary>세부 설정</summary><div className="form-options">
                <label className="field field-wide" htmlFor="schedule-memo"><span className="field-label">메모</span><textarea id="schedule-memo" rows="2" placeholder="메모 (선택)" value={form.memo} onChange={(event) => setForm({ ...form, memo: event.target.value })} /></label>
                <label className="field" htmlFor="schedule-date"><span className="field-label">날짜</span><input id="schedule-date" type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label>
                <label className="field" htmlFor="schedule-time"><span className="field-label">시간</span><input id="schedule-time" type="time" value={form.time} onChange={(event) => setForm({ ...form, time: event.target.value })} /></label>
                <label className="field" htmlFor="schedule-repeat"><span className="field-label">반복</span><select id="schedule-repeat" value={form.repeat} onChange={(event) => setForm({ ...form, repeat: event.target.value })}><option value="none">반복 없음</option><option value="daily">매일</option><option value="weekly">매주</option><option value="monthly">매월</option></select></label>
                <label className="field" htmlFor="schedule-category"><span className="field-label">카테고리</span><select id="schedule-category" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{categories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label>
              </div></details></div>
            <p className="form-error" role="alert" hidden={!formError}>{formError}</p><div className="form-actions"><button id="submit-button" className="add-button" type="submit">{editingId ? "저장" : "추가"}</button></div>
          </form>
          {aiNew.length > 0 && <section className="ai-box" aria-labelledby="ai-box-heading"><div className="ai-box-head"><h3 id="ai-box-heading">AI가 새로 추가한 일정 <span>{aiNew.length}개</span></h3><button className="text-button" type="button" onClick={() => markReviewed(aiNew.map((item) => item.id))}>모두 확인</button></div><ul>{aiNew.map((item) => <li key={item.id}><div><strong>{item.title}</strong><small>{[item.date || "날짜 없음", item.time, sourceLabels[item.source], item.sourceRef].filter(Boolean).join(" · ")}</small></div><button className="text-button" type="button" onClick={() => startEdit(item)}>수정</button><button className="delete-button" type="button" onClick={() => deleteItem(item)}>삭제</button><button className="text-button" type="button" onClick={() => markReviewed([item.id])}>맞아요</button></li>)}</ul></section>}<div className="list-heading"><div className="list-title"><h3>일정 목록</h3><span id="schedule-count" aria-live="polite">{visibleEntries.length}개</span></div><div className="summary-strip" aria-label="일정 요약"><div><span>남은 일정</span><strong>{entries.filter(({ status }) => !["done", "canceled"].includes(status)).length}개</strong></div><div><span>전체</span><strong>{items.length}개</strong></div><div><span>완료</span><strong>{entries.filter(({ status }) => status === "done").length}개</strong></div></div><div className="list-actions"><label className="filter-field" htmlFor="filter-status" hidden={!listMode}>상태<select id="filter-status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">전체</option>{statuses.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}</select></label><div className="view-switch" role="group" aria-label="일정 보기 방식"><button className={`view-button ${listMode ? "is-active" : ""}`} type="button" aria-pressed={listMode} onClick={() => setListMode(true)}>목록</button><button className={`view-button ${!listMode ? "is-active" : ""}`} type="button" aria-pressed={!listMode} onClick={() => setListMode(false)}>그래프</button></div></div></div>
          <div hidden={!listMode}>{!visibleEntries.length && <p className="empty-message">{filter === "all" ? "일정 없음" : "해당 상태의 일정 없음"}</p>}<ul className="schedule-list" aria-label="오늘 일정 목록">{visibleEntries.map((entry) => <Entry key={`${entry.item.id}-${entry.day || "none"}`} entry={entry} onStatus={changeStatus} onEdit={startEdit} onDelete={deleteItem} onNote={openItemNote} />)}</ul></div>
          <div className="graph-view" hidden={listMode}>{!entries.length ? <p className="empty-message">일정 없음</p> : statuses.map(({ value, label }) => <GraphRow key={value} label={label} count={entries.filter(({ status }) => status === value).length} total={entries.length} barClass={`${value}-bar`} />)}</div>
        </section>
      </section>
      <section id="calendar-view" className="page-view" aria-labelledby="calendar-heading" hidden={view !== "calendar"}>
        <header className="page-header"><h1 id="calendar-heading">캘린더</h1></header><div className="calendar-toolbar"><button className="icon-button" type="button" aria-label="이전 달" onClick={() => moveMonth(-1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg></button><h2>{calendarYear}년 {calendarIndex + 1}월</h2><button className="icon-button" type="button" aria-label="다음 달" onClick={() => moveMonth(1)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg></button></div>
        <div className="calendar-weekdays" aria-hidden="true">{["일", "월", "화", "수", "목", "금", "토"].map((day) => <span key={day}>{day}</span>)}</div>
        <div className="calendar-grid" aria-label="월간 캘린더">{Array.from({ length: monthOffset }, (_, index) => <span className="calendar-blank" key={`blank-${index}`} />)}{Array.from({ length: monthLength }, (_, index) => {
          const iso = localISO(new Date(calendarYear, calendarIndex, index + 1)), count = occurrencesOn(items, iso).length;
          return <button className={`calendar-day ${iso === today ? "is-today" : ""} ${iso === selectedDate ? "is-selected" : ""}`} type="button" key={iso} aria-label={`${formatDay(iso)} 일정 ${count}개`} onClick={() => setSelectedDate(iso)}><span>{index + 1}</span>{count > 0 && <small>{count}개</small>}</button>;
        })}</div>
        <section className="day-panel" aria-labelledby="selected-day-heading"><h3 id="selected-day-heading">{selectedDate && formatDay(selectedDate)} 일정</h3>{!dayEntries.length && <p className="muted-message">일정 없음</p>}<ul className="compact-list">{dayEntries.map((entry) => <Entry key={`${entry.item.id}-${entry.day}`} entry={entry} onStatus={changeStatus} onEdit={startEdit} onDelete={deleteItem} onNote={openItemNote} />)}</ul></section>
      </section>
      <section id="records-view" className="page-view" aria-labelledby="records-heading" hidden={view !== "records"}><header className="page-header"><h1 id="records-heading">기록</h1></header><div className="period-switch" role="group" aria-label="기록 기간">{[["week", "주간"], ["month", "월간"]].map(([key, label]) => <button key={key} className={`view-button ${recordPeriod === key ? "is-active" : ""}`} type="button" aria-pressed={recordPeriod === key} onClick={() => setRecordPeriod(key)}>{label}</button>)}</div><div className="record-summary"><span>선택한 기간에 완료한 일정</span><strong>{records.length}개</strong></div><section className="record-section" aria-labelledby="timeline-heading"><h2 id="timeline-heading">날짜별 타임라인</h2><div className="timeline-graph">{recordDates.map((day) => { const done = records.filter((record) => record.day === day); return <div className="timeline-row" key={day}><span>{formatDay(day)}</span><div className="graph-track"><div className="graph-bar done-bar" style={{ width: `${done.length / maxRecords * 100}%` }} /></div><strong>{done.length}개</strong>{done.length > 0 && <small>{done.map((record) => record.title).join(" · ")}</small>}</div>; })}</div></section><section className="record-section" aria-labelledby="category-heading"><h2 id="category-heading">카테고리별 비율</h2><div className="category-graph">{categories.map((category) => <GraphRow key={category} label={category} count={records.filter((record) => record.category === category).length} total={records.length} barClass="category-bar" percent />)}</div></section></section>
      <section id="settings-view" className="page-view" aria-labelledby="settings-heading" hidden={view !== "settings"}><header className="page-header"><h1 id="settings-heading">설정</h1></header><div className="settings-card"><h2>브라우저 알림</h2><p className="info-callout">알림은 브라우저가 열려 있을 때만 작동합니다. 오전 8시 요약, 일정 1시간·10분 전 알림.</p><button className="add-button" type="button" disabled={permission === "granted" || permission === "unsupported"} onClick={requestNotifications}>알림 허용</button><p className="settings-status" aria-live="polite">{settingError || (permission === "unsupported" ? "이 브라우저는 알림을 지원하지 않습니다." : permission === "granted" ? "알림 허용됨" : permission === "denied" ? "브라우저 설정에서 알림 권한을 바꿔 주세요." : "")}</p><div className="setting-options"><label><input type="checkbox" checked={settings.dayBefore} onChange={(event) => saveSettings({ ...settings, dayBefore: event.target.checked })} /> 하루 전 오후 8시 알림</label><label><input type="checkbox" checked={settings.night} onChange={(event) => saveSettings({ ...settings, night: event.target.checked })} /> 밤 9시 미완료 일정 알림</label></div></div><div className="settings-card"><h2>계정</h2><p className="info-callout">일정은 서버에 저장되어 어느 기기에서든 같은 비밀번호로 볼 수 있습니다.</p><button className="text-button" type="button" onClick={logout}>이 기기에서 로그아웃</button></div><IntegrationsPanel active={view === "settings"} onItemsChanged={reloadItems} onAuthError={authLost} /></section>
      <WikiView active={view === "wiki"} onAuthError={authLost} request={wikiRequest} onRequestHandled={() => setWikiRequest(null)} />
    </div></div>
  </main>;
}
