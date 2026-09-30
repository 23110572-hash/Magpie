// Base URL of the FastAPI backend. On Vercel set VITE_API_BASE to the Render URL.
const RAW_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() || "http://localhost:8008";
export const API_BASE = RAW_BASE.replace(/\/+$/, "");

const TOKEN_KEY = "magpie.token";
export const UNAUTHORIZED_EVENT = "magpie:unauthorized";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable - the session just won't persist
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) {
      return data.detail
        .map((d: { msg?: string }) => (d.msg ?? "Invalid input").replace(/^Value error, /, ""))
        .join(" · ");
    }
  } catch {
    // non-JSON body
  }
  return `${res.status} ${res.statusText || "Request failed"}`;
}

function headers(init?: HeadersInit): Headers {
  const h = new Headers(init);
  const token = getToken();
  if (token) h.set("Authorization", `Bearer ${token}`);
  return h;
}

function handleUnauthorized(path: string, status: number) {
  if (status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/register")) {
    setToken("");
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new ApiError(0, `Can't reach the Magpie server at ${API_BASE}. It may be waking up - try again in a few seconds.`);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const h = headers(rest.headers);
  let body = rest.body;
  if (json !== undefined) {
    h.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const res = await send(path, { ...rest, headers: h, body });
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, await errorMessage(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Reads a Server-Sent Events stream with the auth header (EventSource can't send headers). */
export async function streamEvents(path: string, onEvent: (data: unknown) => void, signal: AbortSignal): Promise<void> {
  const res = await send(path, { headers: headers({ Accept: "text/event-stream" }), signal });
  if (!res.ok || !res.body) {
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, await errorMessage(res));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const chunk = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch {
          // ignore malformed events
        }
      }
      split = buffer.indexOf("\n\n");
    }
  }
}

/** Downloads an export with the auth header and saves it with the server's file name. */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await send(path, { headers: headers() });
  if (!res.ok) {
    handleUnauthorized(path, res.status);
    throw new ApiError(res.status, await errorMessage(res));
  }
  const blob = await res.blob();
  const match = /filename="?([^";]+)"?/i.exec(res.headers.get("Content-Disposition") || "");
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = match?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
