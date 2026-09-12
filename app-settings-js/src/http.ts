import { AppSettingsError } from "./errors.js";

/** The subset of `fetch` this SDK uses, so any compatible implementation fits. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A value that can appear in a query string. Arrays become repeated keys. */
export type QueryValue = string | number | boolean | string[] | undefined | null;

/** Per-call options accepted by every method on the client. */
export interface RequestOptions {
  /** Cancels the request, and any retry still pending. */
  signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call. */
  timeoutMs?: number;
  /** Extra headers, merged over the client's own. */
  headers?: Record<string, string>;
}

/** Everything the transport needs to make one call. */
export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  headers: Record<string, string>;
  userAgent?: string;
}

/** Options for building a client's transport. */
export interface TransportOptions {
  /** Where the server lives, such as `https://settings.example.com`. */
  baseUrl: string;
  /** The API key sent as `Authorization: Bearer`. */
  apiKey: string;
  /** A `fetch` implementation. Defaults to the global one. */
  fetch?: FetchLike;
  /** How long one attempt may take. Defaults to 10000; 0 disables the timeout. */
  timeoutMs?: number;
  /** How many times to retry a retryable failure. Defaults to 2. */
  retries?: number;
  /** Base backoff between retries, doubled each time. Defaults to 200. */
  retryDelayMs?: number;
  /** Headers added to every request. */
  headers?: Record<string, string>;
}

/**
 * Builds the transport config, resolving defaults once so each request does no
 * more work than it has to.
 */
export function createTransport(options: TransportOptions): TransportConfig {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AppSettingsError(
      "No `fetch` is available. Pass one as `fetch` in the client options, or run on Node 18+, Bun, Deno or a browser.",
      { code: "invalid_request" },
    );
  }
  if (!options.baseUrl) {
    throw new AppSettingsError("`baseUrl` is required, for example http://localhost:8080", {
      code: "invalid_request",
    });
  }
  if (!options.apiKey) {
    throw new AppSettingsError("`apiKey` is required; every route below /api/v1 needs one", {
      code: "invalid_request",
    });
  }

  return {
    // A trailing slash would double up when paths are appended.
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    apiKey: options.apiKey,
    // Unbind so an implementation that checks its receiver (the browser's) works.
    fetch: (input, init) => fetchImpl(input, init),
    timeoutMs: options.timeoutMs ?? 10_000,
    retries: Math.max(0, options.retries ?? 2),
    retryDelayMs: Math.max(0, options.retryDelayMs ?? 200),
    headers: { ...options.headers },
  };
}

/** One request, before defaults and retries are applied. */
export interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  options?: RequestOptions;
}

/**
 * Performs a request and decodes its body.
 *
 * Returns `undefined` for a 204, which is what every successful DELETE returns.
 */
export async function request<T>(config: TransportConfig, spec: RequestSpec): Promise<T> {
  const url = config.baseUrl + spec.path + buildQuery(spec.query);
  const label = `${spec.method} ${spec.path}`;
  const timeoutMs = spec.options?.timeoutMs ?? config.timeoutMs;

  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
    ...lowercaseKeys(spec.options?.headers),
  };
  let payload: string | undefined;
  if (spec.body !== undefined) {
    payload = JSON.stringify(spec.body);
    headers["content-type"] = "application/json";
  }

  // POST is the only non-idempotent method here, so it is the only one a retry
  // could duplicate. Everything else is safe to repeat.
  const attempts = spec.method === "POST" ? 1 : config.retries + 1;
  let lastError: AppSettingsError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await delay(backoffFor(attempt, config.retryDelayMs, lastError), spec.options?.signal);
    }

    let response: Response;
    try {
      response = await config.fetch(url, {
        method: spec.method,
        headers,
        body: payload,
        signal: timeoutSignal(timeoutMs, spec.options?.signal),
      });
    } catch (cause) {
      lastError = fromThrown(cause, label, spec.options?.signal, timeoutMs);
      // An abort is the caller's decision, and a timeout has already spent its
      // budget on a signal we cannot renew. Neither is worth another attempt.
      if (lastError.code === "aborted" || lastError.code === "timeout") throw lastError;
      continue;
    }

    if (response.ok) return (await decode<T>(response, label)) as T;

    lastError = await errorFromResponse(response, label);
    if (!lastError.retryable || attempt === attempts - 1) throw lastError;
  }

  throw lastError ?? new AppSettingsError(`${label} failed`, { code: "network_error", request: label });
}

/** Renders a query string, repeating a key for each element of an array. */
export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== "") params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }

  const rendered = params.toString();
  return rendered ? `?${rendered}` : "";
}

/** Reads a successful body, tolerating the empty one a 204 carries. */
async function decode<T>(response: Response, label: string): Promise<T | undefined> {
  if (response.status === 204) return undefined;

  const text = await response.text();
  if (text === "") return undefined;

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new AppSettingsError(`${label} returned a body that is not JSON`, {
      code: "invalid_response",
      status: response.status,
      requestId: response.headers.get("x-request-id") ?? undefined,
      request: label,
      body: text.slice(0, 512),
      cause,
    });
  }
}

/**
 * Turns a failed response into an error, preferring the server's own message.
 * Every endpoint returns `{"error": {"code", "message"}}`, so this is usually
 * exact; a proxy in between might not, hence the fallbacks.
 */
async function errorFromResponse(response: Response, label: string): Promise<AppSettingsError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text().catch(() => "");

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  const detail = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const message = detail?.message ?? (text ? text.slice(0, 512) : response.statusText) ?? "request failed";

  return new AppSettingsError(`${label} failed with ${response.status}: ${message}`, {
    code: (detail?.code as AppSettingsError["code"]) ?? statusToCode(response.status),
    status: response.status,
    requestId,
    request: label,
    body,
  });
}

/** Maps a status onto the code the server would have used for it. */
function statusToCode(status: number): AppSettingsError["code"] {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 503:
      return "unavailable";
    default:
      return status >= 500 ? "internal_error" : "invalid_request";
  }
}

/** Classifies a throw from `fetch` itself, which never reached a response. */
function fromThrown(cause: unknown, label: string, signal: AbortSignal | undefined, timeoutMs: number): AppSettingsError {
  const aborted = cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");

  if (aborted && signal?.aborted) {
    return new AppSettingsError(`${label} was aborted`, { code: "aborted", request: label, cause });
  }
  if (aborted) {
    return new AppSettingsError(`${label} timed out after ${timeoutMs}ms`, {
      code: "timeout",
      request: label,
      cause,
    });
  }
  return new AppSettingsError(`${label} could not reach the server: ${errorText(cause)}`, {
    code: "network_error",
    request: label,
    cause,
  });
}

/** Combines the caller's signal with a timeout, using whichever exist. */
function timeoutSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal | undefined {
  const timeout = timeoutMs > 0 && typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;

  if (!timeout) return signal;
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);

  // An older runtime without AbortSignal.any: the caller's own signal wins,
  // since losing cancellation is worse than losing a timeout.
  return signal;
}

/** Honours `Retry-After` when the server sent one, else backs off exponentially. */
function backoffFor(attempt: number, base: number, previous: AppSettingsError | undefined): number {
  const retryAfter = retryAfterMs(previous);
  if (retryAfter !== undefined) return retryAfter;

  const exponential = base * 2 ** (attempt - 1);
  // Jitter keeps a fleet of clients from retrying in lockstep after an outage.
  return exponential + Math.random() * base;
}

function retryAfterMs(error: AppSettingsError | undefined): number | undefined {
  if (error?.status !== 429 && error?.status !== 503) return undefined;
  const header = (error.body as { retry_after?: number } | undefined)?.retry_after;
  return typeof header === "number" && header >= 0 ? header * 1000 : undefined;
}

/** A cancellable sleep, so an abort during backoff takes effect immediately. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });

    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(new AppSettingsError("the request was aborted", { code: "aborted" }));
    }
  });
}

function lowercaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
