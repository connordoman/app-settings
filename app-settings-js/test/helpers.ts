import type { FetchLike } from "../src/index.ts";
import type { ResolveResponse, ResolvedSetting } from "../src/index.ts";

/** One request the stub saw, so a test can assert on what was sent. */
export interface Recorded {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A handler keyed by `METHOD /path`, or a catch-all function. */
export type Route = (request: Recorded) => Response | Promise<Response>;

/** A `fetch` stand-in that records calls and answers from a route table. */
export function stubFetch(routes: Record<string, Route | unknown>) {
  const calls: Recorded[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const recorded: Recorded = {
      method,
      url,
      path: url.pathname,
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(recorded);

    const route = routes[`${method} ${url.pathname}`] ?? routes["*"];
    if (route === undefined) return json({ error: { code: "not_found", message: "no stub route" } }, 404);
    if (typeof route === "function") return (route as Route)(recorded);
    return json(route);
  };

  return { fetch: fetchImpl, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function apiError(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

/** A resolved setting with sensible defaults, so a test names only what matters. */
export function setting(overrides: Partial<ResolvedSetting> & { name: string }): ResolvedSetting {
  return {
    id: `id-${overrides.name}`,
    description: "",
    type: "BOOLEAN",
    role: "user",
    scope: "PERSONAL",
    platform: "web",
    environment: "production",
    value: null,
    source: "DEFAULT",
    ...overrides,
  };
}

export function resolution(settings: ResolvedSetting[], overrides: Partial<ResolveResponse> = {}): ResolveResponse {
  return {
    environment: "production",
    platforms: ["web"],
    user_id: "alice",
    role: "user",
    settings,
    resolved_at: "2026-01-02T20:04:05Z",
    ...overrides,
  };
}
