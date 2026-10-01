// 서버 API와 통신한다. 로그인 토큰은 이 브라우저에만 저장한다.
const BASE = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api`;
const TOKEN_KEY = "check-session-token";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; }
}
export function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* 저장이 막혀도 이번 세션은 쓸 수 있다. */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 없으면 그만이다. */ }
}

async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
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
    throw Object.assign(new Error(detail || `요청 실패 (${response.status})`), { status: response.status });
  }
  return response.status === 204 ? null : response.json();
}

export const api = {
  login: (password) => request("/login", { method: "POST", body: JSON.stringify({ password }) }),
  items: () => request("/items"),
  saveItems: (items) => request("/items", { method: "PUT", body: JSON.stringify(items) }),
  settings: () => request("/settings"),
  saveSettings: (settings) => request("/settings", { method: "PUT", body: JSON.stringify(settings) }),
};
