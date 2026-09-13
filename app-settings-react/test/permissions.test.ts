import { describe, expect, test } from "bun:test";

import {
  canCreateSetting,
  grants,
  layerScopes,
  SETTING_LAYERS,
} from "@/registry/app-settings/lib/app-settings/permissions";

describe("grants", () => {
  test("the wildcard grants every scope", () => {
    expect(grants(["*"], "settings:write")).toBe(true);
  });

  test("a scope grants only itself", () => {
    expect(grants(["settings:read"], "settings:write")).toBe(false);
    expect(grants(["settings:write"], "settings:write")).toBe(true);
  });
});

describe("canCreateSetting", () => {
  test("every layer needs settings:write by default, as the server does", () => {
    for (const layer of SETTING_LAYERS) {
      expect(canCreateSetting(["settings:write"], layer).allowed).toBe(true);
      expect(canCreateSetting(["resolve", "values:write"], layer)).toEqual({
        allowed: false,
        missing: ["settings:write"],
      });
    }
  });

  test("requirements tighten one layer without touching the others", () => {
    const requirements = { server: ["settings:write", "values:write"] as const };

    expect(canCreateSetting(["settings:write"], "server", requirements)).toEqual({
      allowed: false,
      missing: ["values:write"],
    });
    expect(canCreateSetting(["settings:write"], "personal", requirements).allowed).toBe(true);
  });

  test("a key with no scopes is refused everything", () => {
    for (const layer of SETTING_LAYERS) {
      expect(canCreateSetting([], layer).allowed).toBe(false);
    }
  });

  test("each layer creates a definition of the matching scope", () => {
    expect(layerScopes).toEqual({ personal: "PERSONAL", group: "INTERMEDIATE", server: "SERVER" });
  });
});
