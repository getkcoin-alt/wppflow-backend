import { fail } from "../../middleware/http.js";

// Tests replace the network so nothing leaves the machine.
let fetcher = (url, init) => fetch(url, init);
export const setAiFetch = (fn) => {
  fetcher = fn || ((url, init) => fetch(url, init));
};

// POSTs JSON and returns the parsed answer. A failure carries the status, how long to wait if the provider said so, and a
// message that never contains the key.
export async function postJson(url, { headers = {}, body, timeoutMs = 25_000 }) {
  let res;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const e = fail(503, "The AI provider could not be reached.");
    e.code = error?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK";
    throw e;
  }
  const text = await res.text().catch(() => "");
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const detail = String(data?.error?.message || data?.message || text || "").replace(/\s+/g, " ").slice(0, 200);
    const e = fail(res.status === 429 ? 429 : res.status >= 500 ? 503 : res.status === 401 || res.status === 403 ? 503 : 502, `The AI provider answered ${res.status}.`);
    e.upstream = res.status;
    e.detail = detail;
    const wait = Number(res.headers?.get?.("retry-after"));
    if (wait > 0) e.retryAfter = wait;
    throw e;
  }
  return data;
}
