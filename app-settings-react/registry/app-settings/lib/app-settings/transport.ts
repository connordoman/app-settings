/**
 * The two transports most boards need.
 *
 * {@link transportFromClient} points the UI straight at an App Settings
 * deployment, which is the internal-admin case: the page holds an API key and
 * talks to the API directly.
 *
 * {@link createHttpTransport} points it at your own API instead. As long as
 * your endpoints speak App Settings' resolution shape, every component and hook
 * works unchanged — your server keeps the API key, and the browser never sees
 * it.
 */

import type { AppSettingsClient } from "app-settings-js";

import type {
  ResolveQuery,
  ResolveResponse,
  SettingsTransport,
  WriteRequest,
} from "@/registry/app-settings/lib/app-settings/types";

/** Wraps an `AppSettingsClient` from `app-settings-js`. */
export function transportFromClient(client: AppSettingsClient): SettingsTransport {
  return {
    async resolve(query, signal) {
      const options = {
        environment: query.environment,
        platform: query.platform,
        role: query.role,
        groupId: query.groupId,
        signal,
      };
      const snapshot = query.userId
        ? await client.resolveUser(query.userId, options)
        : await client.resolveServer(options);
      return snapshot.toJSON();
    },

    async write(request, signal) {
      const { setting, value, layer } = request;
      const clearing = value === undefined;

      if (layer === "server") {
        await (clearing
          ? client.values.server.clear(setting.id, { signal })
          : client.values.server.set(setting.id, value, { signal }));
        return;
      }

      if (layer === "personal") {
        const userId = required(request.userId, "personal", "userId");
        await (clearing
          ? client.values.personal.clear(setting.id, userId, { signal })
          : client.values.personal.set(setting.id, userId, value, { signal }));
        return;
      }

      const groupId = required(request.groupId, "group", "groupId");
      await (clearing
        ? client.values.group.clear(setting.id, groupId, { signal })
        : client.values.group.set(setting.id, groupId, value, {
            visible: request.visible,
            enforced: request.enforced,
            signal,
          }));
    },
  };
}

/** One request, described rather than performed, so a caller can shape it. */
export interface HttpRequestSpec {
  url: string;
  method?: string;
  /** Serialised as JSON. Omit for a request with no body. */
  body?: unknown;
  headers?: Record<string, string>;
}

/** Either a bare URL or a full description of the request to make. */
export type HttpRoute<T> = string | ((input: T) => HttpRequestSpec | string);

export interface HttpTransportOptions {
  /**
   * Where a resolution comes from.
   *
   * A string is called with the query appended as `user_id`, `environment`,
   * `platform`, `role` and `group_id` parameters, which is what an endpoint
   * proxying App Settings usually wants. Pass a function for anything else.
   * The response body must be an App Settings resolution.
   */
  resolve: HttpRoute<ResolveQuery>;
  /**
   * Where a write goes. Omit it for a read-only board.
   *
   * A string receives a `POST` whose body is
   * `{ setting_id, name, layer, value, clear, user_id, group_id, visible, enforced }`.
   * Pass a function to write to a REST route of your own shape.
   */
  write?: HttpRoute<WriteRequest>;
  /** Sent on every request. A function is called per request, for a fresh token. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Forwarded to `fetch`, for a session-cookie API. */
  credentials?: RequestCredentials;
  /** Swapped in for tests, or for a framework's instrumented fetch. */
  fetch?: typeof globalThis.fetch;
}

/** Builds a transport over your own HTTP API. */
export function createHttpTransport(options: HttpTransportOptions): SettingsTransport {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function send(spec: HttpRequestSpec, signal?: AbortSignal): Promise<Response> {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    const hasBody = spec.body !== undefined;

    const response = await doFetch(spec.url, {
      method: spec.method ?? (hasBody ? "POST" : "GET"),
      headers: {
        Accept: "application/json",
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...extra,
        ...spec.headers,
      },
      body: hasBody ? JSON.stringify(spec.body) : undefined,
      credentials: options.credentials,
      signal,
    });

    if (!response.ok) {
      throw new SettingsRequestError(response.status, spec, await readMessage(response));
    }
    return response;
  }

  const transport: SettingsTransport = {
    async resolve(query, signal) {
      const spec = resolveSpec(options.resolve, query, () => ({
        url: appendQuery(routeUrl(options.resolve, query), resolveParams(query)),
      }));
      const response = await send(spec, signal);
      return (await response.json()) as ResolveResponse;
    },
  };

  if (options.write) {
    const route = options.write;
    transport.write = async (request, signal) => {
      const spec = resolveSpec(route, request, () => ({
        url: routeUrl(route, request),
        method: "POST",
        body: writeBody(request),
      }));
      await send(spec, signal);
    };
  }

  return transport;
}

/** A failed request against your own API, with enough context to debug it. */
export class SettingsRequestError extends Error {
  override readonly name = "SettingsRequestError";

  constructor(
    readonly status: number,
    readonly request: HttpRequestSpec,
    readonly detail?: string,
  ) {
    super(
      `${request.method ?? "GET"} ${request.url} failed with ${status}` +
        (detail ? `: ${detail}` : ""),
    );
  }
}

/** The wire body a string `write` route receives. */
export function writeBody(request: WriteRequest): Record<string, unknown> {
  return {
    setting_id: request.setting.id,
    name: request.setting.name,
    layer: request.layer,
    value: request.value ?? null,
    clear: request.value === undefined,
    user_id: request.userId,
    group_id: request.groupId,
    visible: request.visible,
    enforced: request.enforced,
  };
}

/** The query parameters a string `resolve` route receives. */
export function resolveParams(query: ResolveQuery): Record<string, string | string[] | undefined> {
  return {
    user_id: query.userId,
    environment: query.environment,
    platform: query.platform,
    role: query.role,
    group_id: query.groupId,
  };
}

/** Appends parameters, keeping whatever the URL already carried. */
export function appendQuery(
  url: string,
  params: Record<string, string | string[] | undefined>,
): string {
  const [base, existing] = url.split("?", 2);
  const search = new URLSearchParams(existing);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) search.append(key, one);
  }

  const query = search.toString();
  return query ? `${base}?${query}` : (base as string);
}

function resolveSpec<T>(
  route: HttpRoute<T>,
  input: T,
  fallback: () => HttpRequestSpec,
): HttpRequestSpec {
  if (typeof route === "string") return fallback();
  const spec = route(input);
  return typeof spec === "string" ? { url: spec } : spec;
}

function routeUrl<T>(route: HttpRoute<T>, input: T): string {
  if (typeof route === "string") return route;
  const spec = route(input);
  return typeof spec === "string" ? spec : spec.url;
}

async function readMessage(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    if (!text) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const body = parsed as { error?: { message?: string }; message?: string };
      return body.error?.message ?? body.message ?? text.slice(0, 200);
    }
    return text.slice(0, 200);
  } catch {
    return undefined;
  }
}

function required(value: string | undefined, layer: string, field: string): string {
  if (!value) {
    throw new Error(
      `writing the ${layer} layer needs a ${field}: pass it to the hook, or set a default on <AppSettingsProvider>`,
    );
  }
  return value;
}
