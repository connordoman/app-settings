import { describe, expect, test } from "bun:test";

import {
  appendQuery,
  createHttpTransport,
  resolveParams,
  SettingsRequestError,
  writeBody,
} from "@/registry/app-settings/lib/app-settings/transport";
import { resolution, setting } from "./fixtures";

/** A fetch that records what it was asked for and replies with what it was told. */
function recordingFetch(reply: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];

  const fetchLike = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetchLike, calls };
}

describe("createHttpTransport", () => {
  test("a string route becomes a GET with the query appended", async () => {
    const body = resolution([setting({ name: "a", value: 1, source: "SERVER" })]);
    const { fetchLike, calls } = recordingFetch({ body });

    const transport = createHttpTransport({ resolve: "/api/settings", fetch: fetchLike });
    const response = await transport.resolve({
      userId: "alice",
      platform: ["web", "ios"],
      environment: "production",
    });

    expect(response.settings[0]?.name).toBe("a");

    const call = calls[0];
    expect(call?.init.method).toBe("GET");
    expect(call?.url).toBe(
      "/api/settings?user_id=alice&environment=production&platform=web&platform=ios",
    );
  });

  test("query parameters already on the URL are kept", async () => {
    const { fetchLike, calls } = recordingFetch({ body: resolution([]) });

    const transport = createHttpTransport({
      resolve: "/api/settings?tenant=acme",
      fetch: fetchLike,
    });
    await transport.resolve({ userId: "alice" });

    expect(calls[0]?.url).toBe("/api/settings?tenant=acme&user_id=alice");
  });

  test("a function route shapes the request itself", async () => {
    const { fetchLike, calls } = recordingFetch({ body: resolution([]) });

    const transport = createHttpTransport({
      resolve: (query) => ({
        url: `/api/users/${query.userId}/settings`,
        headers: { "X-Trace": "1" },
      }),
      fetch: fetchLike,
    });
    await transport.resolve({ userId: "alice" });

    expect(calls[0]?.url).toBe("/api/users/alice/settings");
    expect((calls[0]?.init.headers as Record<string, string>)["X-Trace"]).toBe("1");
  });

  test("a string write route posts the whole request", async () => {
    const { fetchLike, calls } = recordingFetch();
    const transport = createHttpTransport({
      resolve: "/api/settings",
      write: "/api/settings/write",
      headers: { Authorization: "Bearer token" },
      fetch: fetchLike,
    });

    await transport.write?.({
      setting: setting({ name: "rate.limit" }),
      value: 10,
      layer: "server",
    });

    const call = calls[0];
    expect(call?.url).toBe("/api/settings/write");
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>).Authorization).toBe("Bearer token");
    expect(JSON.parse(String(call?.init.body))).toMatchObject({
      setting_id: "id-rate.limit",
      name: "rate.limit",
      layer: "server",
      value: 10,
      clear: false,
    });
  });

  test("clearing is a write with no value, not a write of null", () => {
    const cleared = writeBody({
      setting: setting({ name: "a" }),
      value: undefined,
      layer: "personal",
      userId: "alice",
    });

    expect(cleared.clear).toBe(true);
    expect(cleared.value).toBeNull();
    expect(cleared.user_id).toBe("alice");
  });

  test("a transport with no write route is read-only", () => {
    const transport = createHttpTransport({ resolve: "/api/settings" });
    expect(transport.write).toBeUndefined();
  });

  test("a failure carries the status and the server's own message", async () => {
    const { fetchLike } = recordingFetch({
      status: 403,
      body: { error: { message: "key may not write the server layer" } },
    });

    const transport = createHttpTransport({ resolve: "/api/settings", fetch: fetchLike });

    await expect(transport.resolve({})).rejects.toThrow(SettingsRequestError);
    await expect(transport.resolve({})).rejects.toThrow("403");
    await expect(transport.resolve({})).rejects.toThrow("may not write the server layer");
  });

  test("headers can be produced per request, for a token that expires", async () => {
    const { fetchLike, calls } = recordingFetch({ body: resolution([]) });
    let issued = 0;

    const transport = createHttpTransport({
      resolve: "/api/settings",
      headers: () => ({ Authorization: `Bearer ${++issued}` }),
      fetch: fetchLike,
    });

    await transport.resolve({});
    await transport.resolve({});

    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer 1");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe("Bearer 2");
  });
});

describe("query building", () => {
  test("undefined fields are left out", () => {
    expect(appendQuery("/x", resolveParams({ userId: "alice" }))).toBe("/x?user_id=alice");
    expect(appendQuery("/x", resolveParams({}))).toBe("/x");
  });

  test("a repeated parameter is repeated, not joined", () => {
    expect(appendQuery("/x", { platform: ["web", "ios"] })).toBe("/x?platform=web&platform=ios");
  });
});
