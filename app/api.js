// 서버 API와 통신한다. 로그인 토큰은 이 브라우저에만 저장한다.
export const BASE = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api`;
const TOKEN_KEY = "check-session-token";
let serverTime = ""; // 마지막으로 일정을 받은 서버 시각. 저장할 때 함께 보낸다.

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* 저장이 막혀도 이번 세션은 쓸 수 있다. */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 없으면 그만이다. */ }
}

async function raw(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${BASE}${path}`, { ...options, headers });
  } catch {
    throw Object.assign(new Error("서버에 연결하지 못했습니다."), { status: 0 });
  }
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).detail || ""; } catch { /* 본문이 없을 수 있다. */ }
    throw Object.assign(new Error(typeof detail === "string" && detail ? detail : `요청 실패 (${response.status})`), { status: response.status });
  }
  return response;
}
async function request(path, options = {}) {
  const response = await raw(path, options);
  const stamp = response.headers.get("X-Server-Time");
  if (stamp) serverTime = stamp;
  return response.json();
}
const json = (method, body) => ({ method, body: JSON.stringify(body) });

export const api = {
  login: (password) => request("/login", json("POST", { password })),
  items: () => request("/items"),
  saveItems: (items) => request(`/items${serverTime ? `?since=${encodeURIComponent(serverTime)}` : ""}`, json("PUT", items)),
  settings: () => request("/settings"),
  saveSettings: (settings) => request("/settings", json("PUT", settings)),
  notes: (q = "") => request(`/notes${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  note: (id) => request(`/notes/${id}`),
  createNote: (note) => request("/notes", json("POST", note)),
  updateNote: (id, note) => request(`/notes/${id}`, json("PUT", note)),
  deleteNote: (id) => request(`/notes/${id}`, { method: "DELETE" }),
  summarize: (id) => request(`/notes/${id}/summary`, { method: "POST" }),
  ask: (question) => request("/ask", json("POST", { question })),
  exportNotes: async () => (await raw("/notes/export")).blob(),
  integrations: () => request("/integrations"),
  saveIntegration: (name, body) => request(`/integrations/${name}`, json("PUT", body)),
  testIntegration: (name) => request(`/integrations/${name}/test`, { method: "POST" }),
  syncNow: (only) => request(`/integrations/sync${only ? `?only=${only}` : ""}`, { method: "POST" }),
};
