"use client";

// 노트(개인 위키) 화면. 왼쪽 목록, 오른쪽 읽기/편집. [[제목]]으로 노트끼리 연결한다.
import { useEffect, useState } from "react";
import { api } from "./api";
import { Markdown } from "./markdown";

export default function NotesView({ active, items, onAuthError, request, onRequestHandled }) {
  const [list, setList] = useState([]);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState(null); // 열린 노트 (links, backlinks 포함)
  const [draft, setDraft] = useState(null); // 편집 중인 값 {title, body, item_id}
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [summary, setSummary] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);

  function fail(err) {
    if (err.status === 401) onAuthError();
    else setError(err.message);
  }
  async function refresh(q = query) {
    try { setList(await api.notes(q.trim())); } catch (err) { fail(err); }
  }
  async function open(id) {
    setError(""); setSummary(""); setDraft(null);
    try { setNote(await api.note(id)); } catch (err) { fail(err); }
  }
  // [[제목]] 링크를 누르면 그 노트를 열고, 없으면 그 제목으로 새 노트를 만든다.
  async function openByTitle(title, itemId = null) {
    setError("");
    try {
      const found = (await api.notes(title)).find((n) => n.title.toLowerCase() === title.toLowerCase());
      if (found) { await open(found.id); return; }
      setNote(null); setSummary("");
      setDraft({ title, body: "", item_id: itemId });
    } catch (err) { fail(err); }
  }

  useEffect(() => { if (active) refresh(); }, [active]);
  useEffect(() => { if (active && request) { openByTitle(request.title, request.itemId); onRequestHandled(); } }, [active, request]);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setTimeout(() => refresh(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function save(event) {
    event.preventDefault();
    if (!draft.title.trim()) { setError("노트 제목을 입력해 주세요."); return; }
    setBusy("save"); setError("");
    try {
      const saved = note ? await api.updateNote(note.id, draft) : await api.createNote(draft);
      await open(saved.id); await refresh();
    } catch (err) { fail(err); }
    setBusy("");
  }
  async function remove() {
    if (!note || !window.confirm(`"${note.title}" 노트를 삭제할까요?`)) return;
    try { await api.deleteNote(note.id); setNote(null); setDraft(null); await refresh(); } catch (err) { fail(err); }
  }
  async function summarize() {
    setBusy("summary"); setError(""); setSummary("");
    try { setSummary((await api.summarize(note.id)).summary); } catch (err) { fail(err); }
    setBusy("");
  }
  async function ask(event) {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy("ask"); setError(""); setAnswer(null);
    try { setAnswer(await api.ask(question)); } catch (err) { fail(err); }
    setBusy("");
  }
  async function exportAll() {
    try {
      const blob = await api.exportNotes();
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement("a"), { href: url, download: "check-notes.zip" });
      link.click(); URL.revokeObjectURL(url);
    } catch (err) { fail(err); }
  }

  const linkedItem = note?.item_id && items.find((item) => item.id === note.item_id);

  return <section id="notes-view" className="page-view" aria-labelledby="notes-heading" hidden={!active}>
    <header className="page-header notes-header">
      <h1 id="notes-heading">노트</h1>
      <div className="notes-actions">
        <button className="text-button" type="button" onClick={exportAll}>전체 내보내기</button>
        <button className="add-button" type="button" onClick={() => { setNote(null); setSummary(""); setDraft({ title: "", body: "", item_id: null }); }}>새 노트</button>
      </div>
    </header>

    <form className="ask-box" onSubmit={ask}>
      <input type="text" placeholder="노트에게 물어보기 (예: 이번 과제 마감이 언제였지?)" value={question} onChange={(event) => setQuestion(event.target.value)} />
      <button className="add-button" type="submit" disabled={busy === "ask"}>{busy === "ask" ? "생각 중…" : "질문"}</button>
    </form>
    {answer && <div className="ai-answer"><Markdown text={answer.answer} onLink={openByTitle} /><small>참고한 노트: {answer.sources.join(", ")}</small></div>}
    {error && <p className="form-error" role="alert">{error}</p>}

    <div className="notes-layout">
      <aside className="notes-list">
        <input type="search" placeholder="제목·내용 검색" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="노트 검색" />
        {list.length === 0 && <p className="recent-empty">{query ? "검색 결과 없음" : "노트 없음"}</p>}
        <ul>{list.map((n) => <li key={n.id}><button type="button" className={`note-row ${note?.id === n.id ? "is-active" : ""}`} onClick={() => open(n.id)}><strong>{n.title}</strong><small>{n.body.replace(/\s+/g, " ").slice(0, 60) || "내용 없음"}</small></button></li>)}</ul>
      </aside>

      <div className="note-pane">
        {draft ? <form className="note-editor" onSubmit={save}>
          <input className="note-title-input" type="text" placeholder="노트 제목" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} autoFocus />
          <label className="note-item-field">연결할 일정
            <select value={draft.item_id || ""} onChange={(event) => setDraft({ ...draft, item_id: event.target.value || null })}>
              <option value="">없음</option>
              {items.map((item) => <option key={item.id} value={item.id}>{item.title}{item.date ? ` (${item.date})` : ""}</option>)}
            </select>
          </label>
          <textarea placeholder={"마크다운으로 적으세요. 다른 노트는 [[노트 제목]]으로 연결합니다."} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={16} />
          <div className="note-editor-actions">
            <button className="text-button" type="button" onClick={() => setDraft(null)}>취소</button>
            <button className="add-button" type="submit" disabled={busy === "save"}>{busy === "save" ? "저장 중…" : "저장"}</button>
          </div>
        </form> : note ? <article className="note-view">
          <div className="note-view-head">
            <h2>{note.title}</h2>
            <div className="notes-actions">
              <button className="text-button" type="button" onClick={summarize} disabled={busy === "summary"}>{busy === "summary" ? "요약 중…" : "AI 요약"}</button>
              <button className="text-button" type="button" onClick={() => setDraft({ title: note.title, body: note.body, item_id: note.item_id })}>편집</button>
              <button className="delete-button" type="button" onClick={remove}>삭제</button>
            </div>
          </div>
          {linkedItem && <p className="note-meta">연결된 일정: {linkedItem.title}{linkedItem.date ? ` · ${linkedItem.date}` : ""}</p>}
          {summary && <div className="ai-answer"><strong>AI 요약</strong><Markdown text={summary} onLink={openByTitle} /></div>}
          {note.body.trim() ? <Markdown text={note.body} onLink={openByTitle} /> : <p className="recent-empty">내용 없음</p>}
          <div className="note-links">
            <div><h3>이 노트가 가리키는 노트</h3>{note.links.length ? note.links.map((l) => <button key={l.title} type="button" className={`wiki-link ${l.id ? "" : "is-missing"}`} onClick={() => openByTitle(l.title)}>{l.title}{l.id ? "" : " (새로 만들기)"}</button>) : <p className="recent-empty">없음</p>}</div>
            <div><h3>이 노트를 가리키는 노트</h3>{note.backlinks.length ? note.backlinks.map((l) => <button key={l.id} type="button" className="wiki-link" onClick={() => open(l.id)}>{l.title}</button>) : <p className="recent-empty">없음</p>}</div>
          </div>
        </article> : <p className="note-empty">왼쪽에서 노트를 고르거나 새 노트를 만드세요.</p>}
      </div>
    </div>
  </section>;
}
