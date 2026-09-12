/**
 * Wire types for the App Settings HTTP API.
 *
 * Every shape here mirrors what the Go server actually emits, so a response can
 * be handed straight to these types without a translation layer.
 */

/** A value stored against a setting. Everything is JSONB, so JSON is the "any". */
export type SettingValue = unknown;

/** The declared type of a setting. */
export type SettingType = "BOOLEAN" | "NUMBER" | "STRING" | "DATETIME" | "SELECT" | "JSON";

/** The highest layer a setting's value may live in. */
export type SettingScope = "PERSONAL" | "INTERMEDIATE" | "SERVER";

/** The layer an effective value came from. */
export type ValueSource = "UNSET" | "DEFAULT" | "SERVER" | "INTERMEDIATE" | "PERSONAL";

/** One capability an API key may hold. `*` grants all of them. */
export type Scope =
  | "*"
  | "resolve"
  | "settings:read"
  | "settings:write"
  | "values:read"
  | "values:write"
  | "groups:read"
  | "groups:write"
  | "taxonomy:read"
  | "taxonomy:write"
  | "keys:read"
  | "keys:write";

/** A stable, machine-readable error identifier from the server. */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "internal_error"
  | "unavailable";

/** One choice of a SELECT, on the wire as a `[label, value]` tuple. */
export type SelectOption = [label: string, value: SettingValue];

/**
 * The rules attached to a setting's type. Only the fields relevant to the
 * setting's own type are consulted by the server.
 */
export interface TypeConfig {
  /** SELECT: the scalar type its options are drawn from. */
  type?: Exclude<SettingType, "SELECT" | "JSON">;
  /** SELECT: the available choices. */
  options?: SelectOption[];
  /** SELECT: whether the value is an array of options rather than one. */
  multiple?: boolean;

  /** NUMBER bounds, inclusive. */
  min?: number;
  max?: number;
  /** NUMBER: reject values with a fractional part. */
  integer?: boolean;

  /** STRING length bounds, inclusive. */
  min_length?: number;
  max_length?: number;
  /** STRING: RE2 syntax, anchored to the whole value. */
  pattern?: string;
}

/** A setting definition. */
export interface Setting {
  id: string;
  name: string;
  description: string;
  type: SettingType;
  type_config: TypeConfig;
  role: string;
  scope: SettingScope;
  platform: string;
  environment: string;
  default_value: SettingValue;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** A group override that shaped an effective value. */
export interface Override {
  group_id: string;
  /** An enforced override beats the user's own value; an advisory one yields to it. */
  enforced: boolean;
  /** When false, the user is not meant to observe that anything was overridden. */
  visible: boolean;
  /** The user's own value that an enforced override pushed aside, if there was one. */
  replaced_value?: SettingValue;
}

/** One setting collapsed to a single effective value. */
export interface ResolvedSetting {
  id: string;
  name: string;
  description?: string;
  type: SettingType;
  type_config?: TypeConfig;
  role: string;
  scope: SettingScope;
  platform: string;
  environment: string;
  /** The effective value, or null when `source` is `UNSET`. */
  value: SettingValue;
  source: ValueSource;
  override?: Override;
}

/** The body of a resolution response. */
export interface ResolveResponse {
  environment: string;
  platforms?: string[];
  user_id?: string;
  role: string;
  settings: ResolvedSetting[];
  resolved_at: string;
}

/** A stored value in the server layer. */
export interface ServerValue {
  id: string;
  setting_id: string;
  value: SettingValue;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** A stored value in the personal layer. */
export interface PersonalValue extends ServerValue {
  user_id: string;
}

/** A stored value in the intermediate layer. */
export interface IntermediateValue extends ServerValue {
  group_id: string;
  visible: boolean;
  is_enforced: boolean;
}

/** A group of users carrying the intermediate layer. */
export interface Group {
  id: string;
  name: string;
  description: string;
  /** null means the group applies across every environment. */
  environment: string | null;
  /** Higher priority wins when two groups override the same setting. */
  priority: number;
  is_ephemeral: boolean;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** One membership row. */
export interface GroupMember {
  group_id: string;
  user_id: string;
  created_at: string;
  created_by: string;
}

/** An API key, as returned by the server. The token itself is never included. */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  /** Empty means every environment. */
  environments: string[];
  /** Empty means every platform. */
  platforms: string[];
  role: string;
  is_bootstrap: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  created_by: string;
}

/** The one and only time a new key's token is available. */
export interface CreatedApiKey {
  key: ApiKey;
  /** The full token. It is not recoverable: only its hash is kept. */
  token: string;
  warning: string;
}

/** A role. Rank orders roles; a setting is visible to every role at or above its own. */
export interface Role {
  name: string;
  description: string;
  rank: number;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

/** A platform a setting may apply to. */
export interface Platform {
  name: string;
  description: string;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

/** An environment a setting may be scoped to. */
export interface Environment {
  name: string;
  description: string;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

/** A description of the calling key. */
export interface WhoAmI {
  key_id: string;
  name: string;
  /** The key with its secret masked, safe to display. */
  key: string;
  scopes: Scope[];
  environments: string[];
  platforms: string[];
  role: string;
  is_bootstrap: boolean;
}

/** The health endpoint's body. */
export interface Health {
  status: "ok" | "degraded";
  database?: string;
  cache?: string;
}
