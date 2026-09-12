import { describe, expect, test } from "bun:test";

import { AppSettingsError, SettingsSnapshot } from "../src/index.ts";
import { resolution, setting } from "./helpers.ts";

const snapshot = new SettingsSnapshot(
  resolution([
    setting({ name: "dark_mode", type: "BOOLEAN", value: true, source: "PERSONAL" }),
    setting({ name: "page_size", type: "NUMBER", value: 25, source: "SERVER" }),
    setting({ name: "theme", type: "STRING", value: "solarized", source: "DEFAULT" }),
    setting({ name: "digest_at", type: "DATETIME", value: "2026-01-02T20:04:05Z", source: "PERSONAL" }),
    setting({ name: "never_set", type: "STRING", value: null, source: "UNSET" }),
    setting({
      name: "tags",
      type: "SELECT",
      value: ["a", "b"],
      source: "PERSONAL",
      type_config: { type: "STRING", multiple: true, options: [["A", "a"], ["B", "b"]] },
    }),
    setting({ name: "limits", type: "JSON", value: { rate: 10 }, source: "SERVER" }),
  ]),
);

describe("reading values", () => {
  test("returns typed values", () => {
    expect(snapshot.boolean("dark_mode")).toBe(true);
    expect(snapshot.number("page_size")).toBe(25);
    expect(snapshot.string("theme")).toBe("solarized");
    expect(snapshot.date("digest_at")?.toISOString()).toBe("2026-01-02T20:04:05.000Z");
    expect(snapshot.list<string>("tags")).toEqual(["a", "b"]);
    expect(snapshot.json<{ rate: number }>("limits").rate).toBe(10);
  });

  test("falls back for a setting this role cannot see", () => {
    expect(snapshot.boolean("nonexistent")).toBe(false);
    expect(snapshot.boolean("nonexistent", true)).toBe(true);
    expect(snapshot.string("nonexistent", "fallback")).toBe("fallback");
    expect(snapshot.date("nonexistent")).toBeUndefined();
    expect(snapshot.has("nonexistent")).toBe(false);
  });

  test("falls back for an UNSET setting but still reports it as present", () => {
    expect(snapshot.has("never_set")).toBe(true);
    expect(snapshot.isSet("never_set")).toBe(false);
    expect(snapshot.string("never_set", "none")).toBe("none");
    expect(snapshot.source("never_set")).toBe("UNSET");
  });

  test("throws on a type mismatch, which can only be a wrong name", () => {
    expect(() => snapshot.string("dark_mode")).toThrow(AppSettingsError);
    expect(() => snapshot.number("theme")).toThrow(/declared STRING and holds a string, not a number/);
  });

  test("wraps a single select value as a one-element list", () => {
    const single = new SettingsSnapshot(
      resolution([setting({ name: "colour", type: "SELECT", value: "red", source: "PERSONAL" })]),
    );
    expect(single.list("colour")).toEqual(["red"]);
  });

  test("exposes select options for rendering a picker", () => {
    expect(snapshot.options("tags")).toEqual([["A", "a"], ["B", "b"]]);
    expect(snapshot.options("theme")).toEqual([]);
  });
});

describe("overrides", () => {
  const overridden = new SettingsSnapshot(
    resolution([
      setting({
        name: "hidden_policy",
        value: false,
        source: "INTERMEDIATE",
        override: { group_id: "g1", enforced: true, visible: false, replaced_value: true },
      }),
      setting({
        name: "shown_policy",
        value: false,
        source: "INTERMEDIATE",
        override: { group_id: "g1", enforced: true, visible: true },
      }),
      setting({
        name: "advisory",
        value: true,
        source: "INTERMEDIATE",
        override: { group_id: "g2", enforced: false, visible: true },
      }),
      setting({ name: "plain", value: true, source: "PERSONAL" }),
    ]),
  );

  test("withholds an invisible override from the user-facing accessor", () => {
    expect(overridden.override("hidden_policy")?.group_id).toBe("g1");
    expect(overridden.visibleOverride("hidden_policy")).toBeUndefined();
    expect(overridden.visibleOverride("shown_policy")?.enforced).toBe(true);
  });

  test("reports enforcement, which is what disables a control", () => {
    expect(overridden.isEnforced("hidden_policy")).toBe(true);
    expect(overridden.isEnforced("advisory")).toBe(false);
    expect(overridden.isEnforced("plain")).toBe(false);
  });

  test("keeps the replaced value so it can be restored later", () => {
    expect(overridden.override("hidden_policy")?.replaced_value).toBe(true);
  });

  test("lists only what the user may actually change", () => {
    const names = overridden.editable().map((each) => each.name);
    expect(names).toEqual(["advisory", "plain"]);
  });
});

describe("shape", () => {
  test("is iterable and countable", () => {
    expect(snapshot.size).toBe(7);
    expect([...snapshot].map((each) => each.name)).toContain("dark_mode");
    expect(snapshot.names).toContain("page_size");
  });

  test("flattens to a plain object", () => {
    expect(snapshot.toObject().page_size).toBe(25);
  });

  test("round-trips through toJSON", () => {
    const copy = new SettingsSnapshot(snapshot.toJSON());
    expect(copy.number("page_size")).toBe(25);
    expect(copy.environment).toBe("production");
  });

  test("with() produces a new snapshot and leaves the original alone", () => {
    const next = snapshot.with("dark_mode", false);

    expect(next).not.toBe(snapshot);
    expect(next.boolean("dark_mode")).toBe(false);
    expect(snapshot.boolean("dark_mode")).toBe(true);
    expect(next.source("dark_mode")).toBe("PERSONAL");
  });

  test("with() on an unknown name returns the same instance, so nothing re-renders", () => {
    expect(snapshot.with("nonexistent", 1)).toBe(snapshot);
  });

  test("tolerates a server resolution, which carries no user", () => {
    const server = new SettingsSnapshot(resolution([], { user_id: undefined }));
    expect(server.userId).toBeUndefined();
    expect(server.size).toBe(0);
  });
});
