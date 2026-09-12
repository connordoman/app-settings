import { describe, expect, test } from "bun:test";

import { appSettingsKeys, normaliseQuery } from "@/registry/app-settings/lib/app-settings/keys";

describe("query keys", () => {
  test("the same query is the same key however it is written", () => {
    const a = appSettingsKeys.resolution({
      userId: "alice",
      platform: ["web", "ios"],
      environment: undefined,
    });
    const b = appSettingsKeys.resolution({ platform: ["ios", "web"], userId: "alice" });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("a different user is a different key", () => {
    expect(JSON.stringify(appSettingsKeys.resolution({ userId: "alice" }))).not.toBe(
      JSON.stringify(appSettingsKeys.resolution({ userId: "bob" })),
    );
  });

  test("every resolution sits under one prefix, so one call invalidates them all", () => {
    const key = appSettingsKeys.resolution({ userId: "alice" }) as unknown[];
    const prefix = appSettingsKeys.resolutions();

    expect(key.slice(0, prefix.length)).toEqual([...prefix]);
  });

  test("absent fields are dropped rather than recorded as undefined", () => {
    expect(normaliseQuery({ userId: "alice", role: undefined })).toEqual({ userId: "alice" });
    expect(normaliseQuery({})).toEqual({});
  });

  test("a single platform and a one-element list agree", () => {
    expect(normaliseQuery({ platform: "web" })).toEqual(normaliseQuery({ platform: ["web"] }));
  });
});
