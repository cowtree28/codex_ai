"use client";

// 위키 화면. 서버의 llm-wiki 허브를 그대로 보여 주고, 질문·기록·정리는 서버의 Claude Code에 맡긴다.
import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Markdown } from "./markdown";

const sectionNames = { wiki: "위키 문서", output: "결과물", "": "주제 정보", inventory: "목록", raw: "원본 자료", inbox: "받은 자료" };
const actionNames = { query: "질문", ingest: "기록", compile: "정리", init: "새 주제" };
const statusNames = { queued: "대기 중", running: "진행 중", done: "완료", error: "실패" };

function dirname(path) { return path.split("/").slice(0, -1).join("/"); }
function joinPath(base, rel) {
  const parts = base ? base.split("/") : [];
  rel.split("/").forEach((part) => { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); });
  return parts.join("/");
}

export default function WikiView({ active, onAuthError, request, onRequestHandled }) {
  const [topics, setTopics] = useState([]);
  const [topic, setTopic] = useState("");
  const [files, setFiles] = useState([]);
  const [filter, setFilter] = useState("");
  const [doc, setDoc] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [openJob, setOpenJob] = useState(null);
  const [mode, setMode] = useState("query");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [compileAfter, setCompileAfter] = useState(true);
  const [deep, setDeep] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function fail(err) { if (err.status === 401) onAuthError(); else setError(err.message); }
  async function loadTopics() {
    try {
      const list = await api.wikiTopics();
      setTopics(list);
      if (!topic && list.length) setTopic(list[0].name);
    } catch (err) { fail(err); }
  }
  async function loadFiles(name = topic) {
    if (!name) return;
    try { setFiles(await api.wikiFiles(name)); } catch (err) { fail(err); }
  }
  async function loadJobs() {
    try { setJobs(await api.wikiJobs()); } catch (err) { fail(err); }
  }
  async function openPath(path) {
    setError("");
    try { setDoc(await api.wikiFile(path)); } catch (err) { fail(err); }
  }
  // [[slug|이름]] 은 같은 주제에서 파일 이름으로, [글](../a/b.md) 는 현재 문서 기준 상대 경로로 찾는다.
  function follow(link) {
    if (link.href) { openPath(joinPath(dirname(doc.path), link.href)); return; }
    const found = files.find((f) => f.slug === link.slug) || files.find((f) => f.title === link.slug);
    if (found) openPath(found.path);
    else setError(`"${link.slug}" 문서가 아직 없습니다. 정리하기를 실행하면 생길 수 있습니다.`);
  }

  useEffect(() => { if (active) { loadTopics(); loadJobs(); } }, [active]);
  useEffect(() => { if (active && topic) { setDoc(null); loadFiles(topic); } }, [active, topic]);
  // 진행 중인 작업이 있으면 3초마다 상태를 새로 고친다. 끝나면 문서 목록도 새로 읽는다.
  const running = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!active || !running) return undefined;
    const timer = setInterval(async () => {
      try {
        const next = await api.wikiJobs();
        const finished = next.some((job) => job.status === "done" && jobs.find((old) => old.id === job.id && old.status !== "done"));
        setJobs(next);
        if (finished) { loadTopics(); loadFiles(); }
      } catch (err) { fail(err); }
    }, 3000);
    return () => clearInterval(timer);
  }, [active, running, jobs]);
  useEffect(() => {
    if (active && request) { setMode("ingest"); setText(request.text); setTitle(request.title); onRequestHandled(); }
  }, [active, request]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      const options = mode === "ingest" ? { title, compile: compileAfter } : mode === "query" ? { deep } : {};
      const job = await api.wikiRun(mode, topic, text, options);
      setOpenJob(job.id); setText(""); setTitle("");
      await loadJobs();
    } catch (err) { fail(err); }
    setBusy(false);
  }
  async function quick(action, value = "") {
    setError("");
    try { const job = await api.wikiRun(action, topic, value); setOpenJob(job.id); await loadJobs(); } catch (err) { fail(err); }
  }

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const groups = {};
    files.filter((f) => !q || `${f.title} ${f.summary} ${f.path}`.toLowerCase().includes(q))
      .forEach((f) => { (groups[f.section] ||= []).push(f); });
    return Object.entries(groups);
  }, [files, filter]);
  const current = topics.find((t) => t.name === topic);
  const shownJob = jobs.find((job) => job.id === openJob);

  return <section id="wiki-view" className="page-view" aria-labelledby="wiki-heading" hidden={!active}>
    <header className="page-header notes-header">
      <h1 id="wiki-heading">위키</h1>
      <div className="notes-actions">
        <select className="wiki-topic" aria-label="주제" value={topic} onChange={(event) => setTopic(event.target.value)}>
          {topics.map((t) => <option key={t.name} value={t.name}>{t.title} ({t.articles})</option>)}
        </select>
        <button className="text-button" type="button" onClick={() => { const name = window.prompt("새 주제 이름 (영어 소문자, 숫자, -)"); if (name) quick("init", name.trim()); }}>새 주제</button>
        <button className="text-button" type="button" disabled={!topic} onClick={() => quick("compile")}>정리하기</button>
      </div>
    </header>
    <p className="info-callout">서버의 llm-wiki를 그대로 씁니다. 질문·기록·정리는 서버의 Claude Code가 처리하며, 앱에서는 웹 접근과 셸 실행을 막아 둡니다.</p>

    <form className="wiki-task" onSubmit={submit}>
      <div className="view-toggle" role="group" aria-label="작업 종류">
        {["query", "ingest"].map((key) => <button key={key} type="button" className={`view-button ${mode === key ? "is-active" : ""}`} aria-pressed={mode === key} onClick={() => setMode(key)}>{key === "query" ? "질문하기" : "기록하기"}</button>)}
      </div>
      {mode === "ingest" && <input type="text" placeholder="제목 (선택)" value={title} onChange={(event) => setTitle(event.target.value)} />}
      <textarea rows={mode === "ingest" ? 5 : 2} placeholder={mode === "query" ? "위키에게 물어보기 (예: 과학 보고서 마감이 언제야?)" : "위키에 남길 내용을 적으세요. 회의 메모, 배운 것, 일정 정리 등"} value={text} onChange={(event) => setText(event.target.value)} />
      <div className="wiki-task-actions">
        {mode === "ingest" ? <label className="integration-toggle"><input type="checkbox" checked={compileAfter} onChange={(event) => setCompileAfter(event.target.checked)} /> 기록 후 위키 문서로 정리</label>
          : <label className="integration-toggle"><input type="checkbox" checked={deep} onChange={(event) => setDeep(event.target.checked)} /> 깊게 찾기</label>}
        <button className="add-button" type="submit" disabled={busy || !topic}>{mode === "query" ? "질문" : "기록"}</button>
      </div>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}

    {jobs.length > 0 && <div className="wiki-jobs">
      <h3>최근 작업</h3>
      <ul>{jobs.slice(0, 6).map((job) => <li key={job.id}><button type="button" className={`wiki-job ${openJob === job.id ? "is-active" : ""}`} onClick={() => setOpenJob(openJob === job.id ? null : job.id)}>
        <span className={`job-status status-${job.status}`}>{statusNames[job.status]}</span>
        <strong>{actionNames[job.action] || job.action}</strong>
        <small>{job.topic ? `${job.topic} · ` : ""}{job.input || "-"}</small>
      </button></li>)}</ul>
      {shownJob && <div className="ai-answer">{shownJob.status === "done" || shownJob.status === "error" ? <Markdown text={shownJob.result || "(내용 없음)"} onLink={follow} /> : <p>서버의 Claude가 작업 중입니다. 질문은 보통 1분, 정리는 몇 분 걸립니다.</p>}</div>}
    </div>}

    <div className="notes-layout">
      <aside className="notes-list">
        <input type="search" placeholder="문서 검색" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="문서 검색" />
        {!topics.length && <p className="recent-empty">서버에 위키 주제가 없습니다. "새 주제"로 만드세요.</p>}
        {grouped.map(([section, list]) => <div key={section} className="wiki-group"><h3>{sectionNames[section] || section}</h3>
          <ul>{list.map((f) => <li key={f.path}><button type="button" className={`note-row ${doc?.path === f.path ? "is-active" : ""}`} onClick={() => openPath(f.path)}><strong>{f.title}</strong>{f.summary && <small>{f.summary}</small>}</button></li>)}</ul>
        </div>)}
      </aside>
      <div className="note-pane">
        {doc ? <article className="note-view">
          <div className="note-view-head"><h2>{doc.meta.title || doc.path.split("/").pop()}</h2></div>
          <p className="note-meta">{doc.path}{doc.meta.updated ? ` · ${doc.meta.updated}` : ""}</p>
          {doc.meta.summary && <p className="ai-answer">{doc.meta.summary}</p>}
          <Markdown text={doc.body} onLink={follow} />
        </article> : <p className="note-empty">{current ? `${current.title}: 위키 문서 ${current.articles}개. 왼쪽에서 문서를 고르세요.` : "주제를 고르세요."}</p>}
      </div>
    </div>
  </section>;
}
