"use client";

// 설정 화면의 연동 등록 칸. Claude API 키, Gmail, 디스코드를 여기서 등록한다.
// 비밀값은 서버에서 암호화해 저장하고, 화면에는 끝 네 글자만 다시 보여준다.
import { useEffect, useState } from "react";
import { api } from "./api";

const blank = { llm: { provider: "claude_code", oauth_token: "", api_key: "", model: "" }, gmail: { address: "", app_password: "", enabled: false }, discord: { bot_token: "", channel_ids: "", enabled: false } };

function Status({ status }) {
  if (!status?.last_run) return null;
  const when = new Date(status.last_run).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return <p className={`integration-status ${status.last_error ? "is-error" : ""}`}>마지막 실행 {when} · {status.last_error ? status.last_error : `새 일정 ${status.last_added || 0}개`}</p>;
}

export default function IntegrationsPanel({ active, onItemsChanged, onAuthError }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(blank);
  const [message, setMessage] = useState({});
  const [busy, setBusy] = useState("");
  const [minutes, setMinutes] = useState(15);

  function fail(name, err) {
    if (err.status === 401) onAuthError();
    else setMessage((m) => ({ ...m, [name]: { ok: false, text: err.message } }));
  }
  async function load() {
    try {
      const next = await api.integrations();
      setData(next); setMinutes(next.syncMinutes);
      setForm({
        llm: { provider: next.llm.provider || "claude_code", oauth_token: "", api_key: "", model: next.llm.model || "" },
        gmail: { address: next.gmail.address || "", app_password: "", enabled: Boolean(next.gmail.enabled) },
        discord: { bot_token: "", channel_ids: next.discord.channel_ids || "", enabled: Boolean(next.discord.enabled) },
      });
    } catch (err) { fail("all", err); }
  }
  useEffect(() => { if (active) load(); }, [active]);

  const field = (name, key) => ({ value: form[name][key], onChange: (event) => setForm({ ...form, [name]: { ...form[name], [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value } }) });
  const checkbox = (name, key) => ({ checked: form[name][key], onChange: (event) => setForm({ ...form, [name]: { ...form[name], [key]: event.target.checked } }) });

  async function save(name, event) {
    event.preventDefault();
    setBusy(`${name}-save`); setMessage((m) => ({ ...m, [name]: null }));
    try {
      await api.saveIntegration(name, form[name]);
      const result = await api.testIntegration(name);
      setMessage((m) => ({ ...m, [name]: { ok: result.ok, text: result.ok ? `저장했습니다. ${result.message}` : `저장했지만 확인에 실패했습니다. ${result.message}` } }));
      await load();
    } catch (err) { fail(name, err); }
    setBusy("");
  }
  async function clearSecret(name, key) {
    if (!window.confirm("저장된 값을 지울까요?")) return;
    try { await api.saveIntegration(name, { [`clear_${key}`]: true, ...(name !== "llm" ? { enabled: false } : {}) }); await load(); } catch (err) { fail(name, err); }
  }
  async function syncNow(name) {
    setBusy(`${name}-sync`); setMessage((m) => ({ ...m, [name]: null }));
    try {
      const result = (await api.syncNow(name))[name];
      if (!result) setMessage((m) => ({ ...m, [name]: { ok: false, text: "다른 가져오기가 진행 중입니다. 잠시 뒤 다시 누르세요." } }));
      else setMessage((m) => ({ ...m, [name]: { ok: result.ok, text: result.ok ? `새 일정 ${result.added}개를 추가했습니다.` : result.error } }));
      await load(); onItemsChanged();
    } catch (err) { fail(name, err); }
    setBusy("");
  }
  async function saveMinutes(value) {
    setMinutes(value);
    try { await api.saveSettings({ syncMinutes: Number(value) }); } catch (err) { fail("all", err); }
  }

  const note = (name) => message[name] && <p className={`integration-message ${message[name].ok ? "" : "is-error"}`} role="status">{message[name].text}</p>;
  if (!data) return <div className="settings-card"><h2>연동</h2><p className="settings-status">{message.all?.text || "불러오는 중…"}</p></div>;

  return <>
    <form className="settings-card integration-card" onSubmit={(event) => save("llm", event)}>
      <h2>Claude 연결 (AI 기능)</h2>
      <p className="info-callout">노트 요약·질문과 메일·디스코드 일정 추출에 씁니다. 메시지 내용은 도구를 모두 끈 상태로만 Claude에게 전달됩니다.</p>
      <label className="integration-field"><span>연결 방식</span>
        <select {...field("llm", "provider")}><option value="claude_code">Claude Code 구독 (Pro/Max)</option><option value="api">Claude API 키 (사용량 과금)</option></select>
      </label>
      {form.llm.provider === "claude_code" ? <>
        <p className="info-callout">Claude Code가 설치된 컴퓨터의 터미널에서 <code>claude setup-token</code>을 실행하고, 브라우저 로그인 뒤 나오는 토큰을 붙여 넣으세요. 사용량은 구독 한도에서 차감됩니다.</p>
        <label className="integration-field"><span>Claude Code 토큰 {data.llm.secrets.oauth_token && <em>저장됨 {data.llm.secrets.oauth_token}</em>}</span><input type="password" autoComplete="off" placeholder={data.llm.secrets.oauth_token ? "바꿀 때만 입력" : "sk-ant-oat01-..."} {...field("llm", "oauth_token")} /></label>
      </> : <>
        <p className="info-callout"><a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer noopener">Anthropic 콘솔</a>에서 키를 만드세요.</p>
        <label className="integration-field"><span>API 키 {data.llm.secrets.api_key && <em>저장됨 {data.llm.secrets.api_key}</em>}</span><input type="password" autoComplete="off" placeholder={data.llm.secrets.api_key ? "바꿀 때만 입력" : "sk-ant-..."} {...field("llm", "api_key")} /></label>
      </>}
      <label className="integration-field"><span>모델</span><input type="text" placeholder="claude-opus-5-5" {...field("llm", "model")} /></label>
      <div className="integration-actions">
        {form.llm.provider === "claude_code" && data.llm.secrets.oauth_token && <button className="text-button" type="button" onClick={() => clearSecret("llm", "oauth_token")}>토큰 지우기</button>}
        {form.llm.provider === "api" && data.llm.secrets.api_key && <button className="text-button" type="button" onClick={() => clearSecret("llm", "api_key")}>키 지우기</button>}
        <button className="add-button" type="submit" disabled={busy === "llm-save"}>{busy === "llm-save" ? "확인 중…" : "저장하고 확인"}</button>
      </div>
      {note("llm")}
    </form>

    <form className="settings-card integration-card" onSubmit={(event) => save("gmail", event)}>
      <h2>Gmail 일정 자동 등록</h2>
      <p className="info-callout">받은편지함의 최근 메일을 읽어 일정을 찾습니다. 메일은 읽음 처리하지 않습니다. Google 계정의 2단계 인증을 켠 뒤 <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer noopener">앱 비밀번호</a>를 만들어 넣으세요.</p>
      <label className="integration-field"><span>Gmail 주소</span><input type="email" autoComplete="off" placeholder="example@gmail.com" {...field("gmail", "address")} /></label>
      <label className="integration-field"><span>앱 비밀번호 {data.gmail.secrets.app_password && <em>저장됨 {data.gmail.secrets.app_password}</em>}</span><input type="password" autoComplete="off" placeholder={data.gmail.secrets.app_password ? "바꿀 때만 입력" : "16자리 앱 비밀번호"} {...field("gmail", "app_password")} /></label>
      <label className="integration-toggle"><input type="checkbox" {...checkbox("gmail", "enabled")} /> 자동으로 가져오기</label>
      <div className="integration-actions">
        {data.gmail.secrets.app_password && <button className="text-button" type="button" onClick={() => clearSecret("gmail", "app_password")}>연결 해제</button>}
        <button className="text-button" type="button" onClick={() => syncNow("gmail")} disabled={busy === "gmail-sync"}>{busy === "gmail-sync" ? "가져오는 중…" : "지금 가져오기"}</button>
        <button className="add-button" type="submit" disabled={busy === "gmail-save"}>{busy === "gmail-save" ? "확인 중…" : "저장하고 확인"}</button>
      </div>
      <Status status={data.gmail.status} />
      {note("gmail")}
    </form>

    <form className="settings-card integration-card" onSubmit={(event) => save("discord", event)}>
      <h2>디스코드 일정 자동 등록</h2>
      <p className="info-callout"><a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer noopener">디스코드 개발자 포털</a>에서 봇을 만들고 <strong>Message Content Intent</strong>를 켠 뒤 내 서버에 초대하세요. 채널 ID는 디스코드 개발자 모드에서 채널을 우클릭해 복사합니다. DM 속 일정은 봇이 있는 채널로 전달하면 됩니다.</p>
      <label className="integration-field"><span>봇 토큰 {data.discord.secrets.bot_token && <em>저장됨 {data.discord.secrets.bot_token}</em>}</span><input type="password" autoComplete="off" placeholder={data.discord.secrets.bot_token ? "바꿀 때만 입력" : "봇 토큰"} {...field("discord", "bot_token")} /></label>
      <label className="integration-field"><span>읽을 채널 ID (쉼표로 구분)</span><input type="text" placeholder="123456789012345678, 234567890123456789" {...field("discord", "channel_ids")} /></label>
      <label className="integration-toggle"><input type="checkbox" {...checkbox("discord", "enabled")} /> 자동으로 가져오기</label>
      <div className="integration-actions">
        {data.discord.secrets.bot_token && <button className="text-button" type="button" onClick={() => clearSecret("discord", "bot_token")}>연결 해제</button>}
        <button className="text-button" type="button" onClick={() => syncNow("discord")} disabled={busy === "discord-sync"}>{busy === "discord-sync" ? "가져오는 중…" : "지금 가져오기"}</button>
        <button className="add-button" type="submit" disabled={busy === "discord-save"}>{busy === "discord-save" ? "확인 중…" : "저장하고 확인"}</button>
      </div>
      <Status status={data.discord.status} />
      {note("discord")}
    </form>

    <div className="settings-card">
      <h2>자동 가져오기 주기</h2>
      <label className="integration-field"><span>켜 둔 연동을 몇 분마다 확인할까요?</span>
        <select value={minutes} onChange={(event) => saveMinutes(event.target.value)}>{[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m}분</option>)}</select>
      </label>
      {note("all")}
    </div>
  </>;
}
