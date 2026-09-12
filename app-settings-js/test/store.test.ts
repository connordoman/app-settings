import { describe, expect, test } from "bun:test";

import { AppSettingsClient, createSettingsStore } from "../src/index.ts";
import { apiError, json, resolution, setting, stubFetch, type Recorded } from "./helpers.ts";

/** Waits for the store to settle, whichever microtasks it needed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(routes: Record<string, unknown>) {
  const stub = stubFetch(routes);
  const client = new AppSettingsClient({
    baseUrl: "https://settings.test",
    apiKey: "as_test",
    environment: "production",
    fetch: stub.fetch,
    retries: 0,
  });
  return { client, calls: stub.calls };
}

const twoSettings = () =>
  resolution([
    setting({ name: "dark_mode", value: false, source: "DEFAULT" }),
    setting({
      name: "locked",
      value: true,
      source: "INTERMEDIATE",
      override: { group_id: "g1", enforced: true, visible: true },
    }),
  ]);

describe("loading", () => {
  test("fetches nothing until something subscribes", async () => {
    const { client, calls } = harness({ "*": () => json(twoSettings()) });
    createSettingsStore(client, { userId: "alice" });

    await settle();
    expect(calls).toHaveLength(0);
  });

  test("loads on the first subscriber and notifies", async () => {
    const { client } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice" });

    let notifications = 0;
    store.subscribe(() => notifications++);

    expect(store.getSnapshot().status).toBe("loading");
    await settle();

    expect(store.getSnapshot().status).toBe("ready");
    expect(store.getSnapshot().snapshot?.boolean("dark_mode")).toBe(false);
    expect(notifications).toBeGreaterThan(0);
  });

  test("returns a stable state object between changes, as useSyncExternalStore requires", async () => {
    const { client } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice" });
    store.subscribe(() => {});
    await settle();

    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  test("shares one request between concurrent refreshes", async () => {
    const { client, calls } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice" });

    await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    expect(calls).toHaveLength(1);
  });

  test("resolves the server layer when given no user", async () => {
    const { client, calls } = harness({ "*": () => json(resolution([], { user_id: undefined })) });
    const store = createSettingsStore(client);

    await store.refresh();
    expect(calls[0]!.path).toBe("/api/v1/resolve/server");
  });

  test("starts ready from server-rendered data, and fetches nothing extra", async () => {
    const { client, calls } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice", initialData: twoSettings() });

    expect(store.getSnapshot().status).toBe("ready");
    store.subscribe(() => {});
    await settle();

    expect(calls).toHaveLength(0);
    expect(store.getServerSnapshot().snapshot?.has("dark_mode")).toBe(true);
  });
});

describe("failure", () => {
  test("records the error when there is nothing to fall back to", async () => {
    const errors: unknown[] = [];
    const { client } = harness({ "*": () => apiError("forbidden", "wrong environment", 403) });
    const store = createSettingsStore(client, { userId: "alice", onError: (e) => errors.push(e) });

    await store.refresh();

    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().error?.code).toBe("forbidden");
    expect(errors).toHaveLength(1);
  });

  test("keeps the last good snapshot when a refresh fails", async () => {
    let healthy = true;
    const { client } = harness({
      "*": () => (healthy ? json(twoSettings()) : apiError("unavailable", "down", 503)),
    });
    const store = createSettingsStore(client, { userId: "alice" });

    await store.refresh();
    healthy = false;
    await store.refresh();

    expect(store.getSnapshot().status).toBe("ready");
    expect(store.getSnapshot().snapshot?.has("dark_mode")).toBe(true);
    expect(store.getSnapshot().error?.code).toBe("unavailable");
  });

  test("never rejects from refresh, so a caller needs no try/catch", async () => {
    const { client } = harness({ "*": () => apiError("internal_error", "boom", 500) });
    const store = createSettingsStore(client, { userId: "alice" });

    await expect(store.refresh()).resolves.toBeDefined();
  });
});

describe("writing", () => {
  test("shows the new value before the request finishes, then re-resolves", async () => {
    let current = false;
    const { client, calls } = harness({
      "PUT /api/v1/settings/id-dark_mode/personal/alice": () => json({ id: "v1" }),
      "*": () => {
        const body = twoSettings();
        body.settings[0]!.value = current;
        body.settings[0]!.source = "PERSONAL";
        return json(body);
      },
    });

    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();

    current = true;
    const pending = store.set("dark_mode", true);
    // Optimistic: already true, though the write has not returned.
    expect(store.getSnapshot().snapshot?.boolean("dark_mode")).toBe(true);

    await pending;
    expect(store.getSnapshot().snapshot?.boolean("dark_mode")).toBe(true);
    expect(calls.some((call) => call.method === "PUT")).toBe(true);
  });

  test("rolls the value back and rethrows when the write is rejected", async () => {
    const { client } = harness({
      "PUT /api/v1/settings/id-dark_mode/personal/alice": () =>
        apiError("invalid_request", "value: must be a boolean", 400),
      "*": () => json(twoSettings()),
    });

    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();

    await expect(store.set("dark_mode", true)).rejects.toThrow(/must be a boolean/);
    expect(store.getSnapshot().snapshot?.boolean("dark_mode")).toBe(false);
  });

  test("does not pretend an enforced setting changed", async () => {
    const { client } = harness({
      "PUT /api/v1/settings/id-locked/personal/alice": () => json({ id: "v1" }),
      "*": () => json(twoSettings()),
    });

    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();

    const pending = store.set("locked", false);
    expect(store.getSnapshot().snapshot?.boolean("locked")).toBe(true);
    await pending;
    expect(store.getSnapshot().snapshot?.boolean("locked")).toBe(true);
  });

  test("converts a Date, so a DATETIME setting takes one directly", async () => {
    const { client, calls } = harness({
      "PUT /api/v1/settings/id-dark_mode/personal/alice": () => json({ id: "v1" }),
      "*": () => json(twoSettings()),
    });

    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();
    await store.set("dark_mode", new Date("2026-01-02T20:04:05Z"));

    const put = calls.find((call) => call.method === "PUT")!;
    expect(put.body).toEqual({ value: "2026-01-02T20:04:05.000Z" });
  });

  test("clears through DELETE and re-resolves", async () => {
    const { client, calls } = harness({
      "DELETE /api/v1/settings/id-dark_mode/personal/alice": () => new Response(null, { status: 204 }),
      "*": () => json(twoSettings()),
    });

    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();
    await store.clear("dark_mode");

    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  test("explains why a server-layer store cannot write a personal value", async () => {
    const { client } = harness({ "*": () => json(resolution([setting({ name: "x" })], { user_id: undefined })) });
    const store = createSettingsStore(client);
    await store.refresh();

    await expect(store.set("x", true)).rejects.toThrow(/has no personal value/);
  });

  test("rejects a name this role cannot see", async () => {
    const { client } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();

    await expect(store.set("nonexistent", true)).rejects.toThrow(/no setting named/);
  });
});

describe("lifecycle", () => {
  test("switching user discards the old snapshot and reloads", async () => {
    const { client, calls } = harness({
      "*": (request: Recorded) => json(resolution([], { user_id: request.path.split("/").pop() })),
    });

    const store = createSettingsStore(client, { userId: "alice" });
    await store.refresh();
    store.setUser("bob");

    expect(store.getSnapshot().snapshot).toBeNull();
    await settle();

    expect(store.getSnapshot().snapshot?.userId).toBe("bob");
    expect(calls[1]!.path).toBe("/api/v1/resolve/user/bob");
  });

  test("dispose stops further work", async () => {
    const { client, calls } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice" });
    store.subscribe(() => {});
    await settle();

    const before = calls.length;
    store.dispose();
    await store.refresh();

    expect(calls).toHaveLength(before);
  });

  test("unsubscribing the last listener stops the refresh interval", async () => {
    const { client, calls } = harness({ "*": () => json(twoSettings()) });
    const store = createSettingsStore(client, { userId: "alice", refreshIntervalMs: 10 });

    const unsubscribe = store.subscribe(() => {});
    await new Promise((resolve) => setTimeout(resolve, 35));
    unsubscribe();

    const after = calls.length;
    expect(after).toBeGreaterThan(1);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(after);
  });
});
