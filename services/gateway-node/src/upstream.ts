/**
 * Calls to the internal services. Every call has a deadline: without one, a
 * hung upstream holds a request open forever and eventually exhausts the
 * gateway too (cascading failure).
 */

export class UpstreamError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Upstream {
  get(service: "ingest" | "rules", path: string): Promise<unknown>;
  post(service: "rules", path: string, body: unknown): Promise<unknown>;
}

export function httpUpstream(urls: { ingest: string; rules: string }, timeoutMs = 3000): Upstream {
  async function call(service: "ingest" | "rules", path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(new URL(path, urls[service]), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new UpstreamError(service, timedOut ? 504 : 502, `${service} ${timedOut ? "timed out" : "unreachable"}`);
    }
    if (res.status === 404) throw new UpstreamError(service, 404, "not found");
    if (res.status === 400) throw new UpstreamError(service, 400, "bad request");
    if (!res.ok) throw new UpstreamError(service, 502, `${service} returned ${res.status}`);
    return res.json();
  }
  return {
    get: (service, path) => call(service, path, { method: "GET" }),
    post: (service, path, body) =>
      call(service, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}
