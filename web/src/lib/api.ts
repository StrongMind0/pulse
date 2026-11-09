import type { Alert, Device, Reading, Session } from "./types";

export const GATEWAY_URL = (process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080").replace(/\/$/, "");
export const WS_URL = GATEWAY_URL.replace(/^http/, "ws") + "/ws";

const SESSION_KEY = "pulse.session";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/**
 * The token lives in sessionStorage: it survives a reload but not closing the
 * tab, and it is never sent automatically (unlike a cookie), so there is no
 * CSRF surface. The trade-off is XSS exposure, mitigated by React's escaping
 * and by never rendering untrusted HTML.
 */
export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    return s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable (private mode): session lasts until reload */
  }
}

async function request<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(GATEWAY_URL + path, { ...init, headers, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `http_${res.status}`);
  }
  return (await res.json()) as T;
}

export async function login(username: string, password: string): Promise<Session> {
  const r = await request<{ token: string; user: string; expiresAt: number }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return { token: r.token, user: r.user, expiresAt: r.expiresAt };
}

export function api(token: string) {
  return {
    devices: () => request<{ devices: Device[] }>("/api/devices", { method: "GET" }, token),
    readings: (id: string, limit: number) =>
      request<{ readings: Reading[] }>(`/api/devices/${encodeURIComponent(id)}/readings?limit=${limit}`, { method: "GET" }, token),
    alerts: (limit = 200) => request<{ alerts: Alert[]; firing: number }>(`/api/alerts?limit=${limit}`, { method: "GET" }, token),
    rules: () => request<{ rules: RuleDef[] }>("/api/rules", { method: "GET" }, token),
    acknowledge: (id: string) => request<Alert>(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: "POST", body: "{}" }, token),
  };
}

export type Api = ReturnType<typeof api>;

export interface RuleDef {
  id: string;
  name: string;
  type: string;
  devicePrefix: string;
  metric?: string;
  trigger?: number;
}

/** Hard limit for a device's metric, from the threshold rules, for drawing reference lines. */
export function limitLookup(rules: RuleDef[]) {
  return (deviceId: string, metric: string): number | undefined => {
    const r = rules.find(
      (x) => x.type === "threshold" && x.metric === metric && deviceId.startsWith(x.devicePrefix ?? ""),
    );
    return r?.trigger;
  };
}
