// Talking to the backend. The page is normally served by the backend itself;
// opened anywhere else it calls the hosted API.

const SAME_ORIGIN = ["localhost", "127.0.0.1"].includes(location.hostname) || location.hostname.endsWith("onrender.com");
const BASE = SAME_ORIGIN ? "" : "https://pack-ween.onrender.com";

const TOKEN_KEY = "packween.token";
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export { store };

let token = store.get(TOKEN_KEY);
export const hasToken = () => !!token;
export function setToken(t) {
  token = t;
  store.set(TOKEN_KEY, t);
}

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GETs retry while the free-tier server wakes up; POSTs never retry (not idempotent)
export async function api(path, { body, method, retries } = {}) {
  method = method || (body === undefined ? "GET" : "POST");
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  let attempts = retries ?? (method === "GET" ? 3 : 0);
  for (;;) {
    let res;
    try {
      res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      if (attempts-- > 0) { await sleep(1500); continue; }
      throw new ApiError("Can't reach the server. Check your connection.", 0);
    }
    if ((res.status === 502 || res.status === 503) && attempts-- > 0 && !path.startsWith("/streets")) { await sleep(2000); continue; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token && !path.startsWith("/players")) setToken(null);
    if (!res.ok && res.status !== 202) throw new ApiError(data.error || `HTTP ${res.status}`, res.status, data);
    return Object.assign(data, { _status: res.status });
  }
}
