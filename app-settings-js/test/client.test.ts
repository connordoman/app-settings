import { describe, expect, test } from "bun:test";

import { AppSettingsClient, AppSettingsError, isConflict, isNotFound } from "../src/index.ts";
import { apiError, json, resolution, setting, stubFetch } from "./helpers.ts";

function clientWith(routes: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const stub = stubFetch(routes);
  const client = new AppSettingsClient({
    baseUrl: "https://settings.test/",
    apiKey: "as_test_secret",
    environment: "production",
    fetch: stub.fetch,
    retries: 0,
    ...options,
  });
  return { client, calls: stub.calls };
}

describe("construction", () => {
  test("requires a base url and an api key", () => {
    expect(() => new AppSettingsClient({ baseUrl: "", apiKey: "k" })).toThrow(AppSettingsError);
    expect(() => new AppSettingsClient({ baseUrl: "https://x", apiKey: "" })).toThrow(AppSettingsError);
  });

  test("strips a trailing slash from the base url so paths do not double up", async () => {
    const { client, calls } = clientWith({ "GET /api/v1/whoami": { role: "user" } });
    await client.whoami();
    expect(calls[0]!.url.href).toBe("https://settings.test/api/v1/whoami");
  });

  test("sends the key as a bearer token", async () => {
    const { client, calls } = clientWith({ "GET /api/v1/whoami": { role: "user" } });
    await client.whoami();
    expect(calls[0]!.headers.authorization).toBe("Bearer as_test_secret");
  });
});

describe("resolution", () => {
  test("sends the client's environment and returns a snapshot", async () => {
    const { client, calls } = clientWith({
      "GET /api/v1/resolve/user/alice": resolution([
        setting({ name: "dark_mode", value: true, source: "PERSONAL" }),
      ]),
    });

    const snapshot = await client.resolveUser("alice");

    expect(calls[0]!.url.searchParams.get("environment")).toBe("production");
    expect(snapshot.boolean("dark_mode")).toBe(true);
    expect(snapshot.userId).toBe("alice");
  });

  test("repeats platform and group_id for each value", async () => {
    const { client, calls } = clientWith({ "GET /api/v1/resolve/user/alice": resolution([]) });

    await client.resolveUser("alice", { platform: ["web", "mobile"], groupId: ["g1", "g2"] });

    expect(calls[0]!.url.searchParams.getAll("platform")).toEqual(["web", "mobile"]);
    expect(calls[0]!.url.searchParams.getAll("group_id")).toEqual(["g1", "g2"]);
  });

  test("escapes a user id that contains url syntax", async () => {
    const { client, calls } = clientWith({ "*": () => json(resolution([])) });
    await client.resolveUser("user/../admin?x=1");
    expect(calls[0]!.url.pathname).toBe("/api/v1/resolve/user/user%2F..%2Fadmin%3Fx%3D1");
  });

  test("refuses to resolve without an environment anywhere", async () => {
    const { client } = clientWith({}, { environment: undefined });
    await expect(client.resolveUser("alice")).rejects.toThrow(/needs an environment/);
  });
});

describe("errors", () => {
  test("carries the server's code, message and request id", async () => {
    const { client } = clientWith({
      "GET /api/v1/settings/missing": () =>
        new Response(JSON.stringify({ error: { code: "not_found", message: "not found" } }), {
          status: 404,
          headers: { "content-type": "application/json", "x-request-id": "req-7" },
        }),
    });

    const error = await client.settings.get("missing").catch((caught) => caught);

    expect(AppSettingsError.is(error)).toBe(true);
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.requestId).toBe("req-7");
    expect(isNotFound(error)).toBe(true);
    expect(error.retryable).toBe(false);
  });

  test("recognises the cascade conflict a delete raises", async () => {
    const { client } = clientWith({
      "DELETE /api/v1/settings/s1": () =>
        apiError("conflict", "3 stored values would be deleted with this setting", 409),
    });

    const error = await client.settings.delete("s1").catch((caught) => caught);
    expect(isConflict(error)).toBe(true);
  });

  test("falls back to the status when a proxy returns non-JSON", async () => {
    const { client } = clientWith({
      "GET /api/v1/whoami": () => new Response("<html>502</html>", { status: 502 }),
    });

    const error = await client.whoami().catch((caught) => caught);
    expect(error.code).toBe("internal_error");
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });

  test("reports an unreachable server as a network error", async () => {
    const { client } = clientWith({
      "GET /api/v1/whoami": () => {
        throw new TypeError("Failed to fetch");
      },
    });

    const error = await client.whoami().catch((caught) => caught);
    expect(error.code).toBe("network_error");
    expect(error.retryable).toBe(true);
  });
});

describe("retries", () => {
  test("retries a 503 on an idempotent method and succeeds", async () => {
    let attempts = 0;
    const { client } = clientWith(
      {
        "GET /api/v1/whoami": () => {
          attempts++;
          return attempts < 3 ? apiError("unavailable", "starting up", 503) : json({ role: "user" });
        },
      },
      { retries: 3, retryDelayMs: 1 },
    );

    await expect(client.whoami()).resolves.toEqual({ role: "user" } as never);
    expect(attempts).toBe(3);
  });

  test("never retries a POST, which is the only non-idempotent method here", async () => {
    let attempts = 0;
    const { client } = clientWith(
      {
        "POST /api/v1/settings": () => {
          attempts++;
          return apiError("unavailable", "starting up", 503);
        },
      },
      { retries: 3, retryDelayMs: 1 },
    );

    await expect(
      client.settings.create({ name: "x", type: "BOOLEAN", scope: "PERSONAL", platform: "web" }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test("does not retry a 4xx", async () => {
    let attempts = 0;
    const { client } = clientWith(
      {
        "GET /api/v1/whoami": () => {
          attempts++;
          return apiError("forbidden", "nope", 403);
        },
      },
      { retries: 3, retryDelayMs: 1 },
    );

    await expect(client.whoami()).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("writes", () => {
  test("puts a personal value at the right path", async () => {
    const { client, calls } = clientWith({ "*": () => json({ id: "v1" }) });

    await client.values.personal.set("s1", "alice", "dark");

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.path).toBe("/api/v1/settings/s1/personal/alice");
    expect(calls[0]!.body).toEqual({ value: "dark" });
  });

  test("passes visible and enforced on a group override", async () => {
    const { client, calls } = clientWith({ "*": () => json({ id: "v1" }) });

    await client.values.group.set("s1", "g1", false, { enforced: true, visible: false });

    expect(calls[0]!.body).toEqual({ value: false, visible: false, enforced: true });
  });

  test("refuses undefined rather than sending a body the server rejects", async () => {
    const { client } = clientWith({ "*": () => json({}) });
    await expect(client.values.server.set("s1", undefined)).rejects.toThrow(/use clear\(\)/);
  });

  test("sends null, which is a legitimate JSON value", async () => {
    const { client, calls } = clientWith({ "*": () => json({ id: "v1" }) });
    await client.values.server.set("s1", null);
    expect(calls[0]!.body).toEqual({ value: null });
  });

  test("returns nothing for the 204 a clear produces", async () => {
    const { client } = clientWith({ "*": () => new Response(null, { status: 204 }) });
    await expect(client.values.personal.clear("s1", "alice")).resolves.toBeUndefined();
  });

  test("adds cascade only when asked", async () => {
    const { client, calls } = clientWith({ "*": () => new Response(null, { status: 204 }) });

    await client.settings.delete("s1");
    await client.settings.delete("s2", { cascade: true });

    expect(calls[0]!.url.search).toBe("");
    expect(calls[1]!.url.searchParams.get("cascade")).toBe("true");
  });
});

describe("collections", () => {
  test("unwraps the envelope each list endpoint uses", async () => {
    const { client } = clientWith({
      "GET /api/v1/settings": { settings: [{ id: "s1", name: "dark_mode" }] },
      "GET /api/v1/groups": { groups: [{ id: "g1", name: "beta" }] },
      "GET /api/v1/roles": { roles: [{ name: "user", rank: 10 }] },
      "GET /api/v1/keys": { keys: [{ id: "k1" }] },
    });

    expect(await client.settings.list()).toHaveLength(1);
    expect(await client.groups.list()).toHaveLength(1);
    expect(await client.taxonomy.roles()).toHaveLength(1);
    expect(await client.keys.list()).toHaveLength(1);
  });

  test("tolerates a null collection rather than throwing on .length", async () => {
    const { client } = clientWith({ "GET /api/v1/settings": { settings: null } });
    expect(await client.settings.list()).toEqual([]);
  });

  test("keeps a null group environment distinct from an omitted one", async () => {
    const { client, calls } = clientWith({ "*": () => json({ id: "g1" }, 201) });

    await client.groups.create({ name: "everywhere", environment: null });
    await client.groups.create({ name: "here" });

    expect((calls[0]!.body as { environment: unknown }).environment).toBeNull();
    expect((calls[1]!.body as { environment: unknown }).environment).toBe("production");
  });

  test("serialises a Date expiry when minting a key", async () => {
    const { client, calls } = clientWith({ "*": () => json({ token: "as_x" }, 201) });

    await client.keys.create({
      name: "web backend",
      scopes: ["resolve"],
      expiresAt: new Date("2026-06-01T00:00:00Z"),
    });

    expect((calls[0]!.body as { expires_at: string }).expires_at).toBe("2026-06-01T00:00:00.000Z");
  });
});
