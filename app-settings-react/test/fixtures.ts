import type {
  ResolvedSetting,
  ResolveResponse,
  SettingType,
  SettingValue,
  TypeConfig,
  ValueSource,
} from "@/registry/app-settings/lib/app-settings/types";

/** A resolved setting with sensible defaults, so a test states only what it means. */
export function setting(overrides: Partial<ResolvedSetting> & { name?: string } = {}): ResolvedSetting {
  const name = overrides.name ?? "example.setting";
  return {
    id: `id-${name}`,
    name,
    description: "",
    type: "STRING" as SettingType,
    type_config: {} as TypeConfig,
    role: "admin",
    scope: "SERVER",
    platform: "web",
    environment: "test",
    value: null as SettingValue,
    source: "DEFAULT" as ValueSource,
    ...overrides,
  };
}

export function resolution(settings: ResolvedSetting[]): ResolveResponse {
  return {
    environment: "test",
    platforms: ["web"],
    role: "admin",
    settings,
    resolved_at: "2026-01-02T15:04:05Z",
  };
}
