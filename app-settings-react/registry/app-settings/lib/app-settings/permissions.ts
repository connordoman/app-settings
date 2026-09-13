/**
 * What an API key may do, decided from its scopes alone.
 *
 * The server stays the authority — these checks only decide what the UI offers,
 * so an action the key cannot perform is shown disabled rather than failing
 * after someone has filled in a form.
 */

import type {
  Scope,
  SettingLayer,
  SettingScope,
} from "@/registry/app-settings/lib/app-settings/types";

/** Every layer, in the order a chooser lists them. */
export const SETTING_LAYERS = ["personal", "group", "server"] as const satisfies readonly SettingLayer[];

/** The definition scope a new setting of each layer is created with. */
export const layerScopes: Record<SettingLayer, SettingScope> = {
  personal: "PERSONAL",
  group: "INTERMEDIATE",
  server: "SERVER",
};

/** Which scopes must be granted to create a setting in each layer. */
export type CreateSettingRequirements = Record<SettingLayer, readonly Scope[]>;

/**
 * The scopes the server requires to create a setting.
 *
 * `POST /api/v1/settings` asks for `settings:write` whatever the new setting's
 * scope, so every layer starts the same. Tighten one by passing your own
 * requirements, e.g. `{ server: ["settings:write", "values:write"] }`.
 */
export const defaultCreateSettingRequirements: CreateSettingRequirements = {
  personal: ["settings:write"],
  group: ["settings:write"],
  server: ["settings:write"],
};

/** Whether a set of granted scopes satisfies a required one. `*` grants all. */
export function grants(granted: readonly string[], required: Scope): boolean {
  return granted.includes("*") || granted.includes(required);
}

export interface Permission {
  allowed: boolean;
  /** The required scopes the key does not hold. Empty when allowed. */
  missing: Scope[];
}

/** Whether a key with these scopes may create a setting in a layer. */
export function canCreateSetting(
  granted: readonly string[],
  layer: SettingLayer,
  requirements: Partial<CreateSettingRequirements> = {},
): Permission {
  const required = requirements[layer] ?? defaultCreateSettingRequirements[layer];
  const missing = required.filter((scope) => !grants(granted, scope));
  return { allowed: missing.length === 0, missing };
}
