/**
 * A TypeScript SDK for the App Settings API.
 *
 * It has no dependencies and runs anywhere `fetch` does: browsers, Node 18+,
 * Bun, Deno and edge runtimes.
 */

export { AppSettingsClient } from "./client.ts";
export type {
  ClientOptions,
  CreateGroupInput,
  CreateKeyInput,
  CreateSettingInput,
  FetchLike,
  GroupValueOptions,
  ListSettingsOptions,
  RequestOptions,
  ResolveOptions,
  ResolveUserOptions,
  UpdateSettingInput,
} from "./client.ts";

export { SettingsSnapshot, snapshotFrom } from "./snapshot.ts";

export { createSettingsStore } from "./store.ts";
export type { SettingsState, SettingsStore, SettingsStoreOptions } from "./store.ts";

export {
  AppSettingsError,
  isConflict,
  isForbidden,
  isInvalidRequest,
  isNotFound,
  isUnauthorized,
} from "./errors.ts";
export type { AnyErrorCode, ClientErrorCode } from "./errors.ts";

export { isInstant, localToInstant, parseInstant, toDateTimeLocal, toInstant } from "./datetime.ts";

export type {
  ApiKey,
  CreatedApiKey,
  Environment,
  ErrorCode,
  Group,
  GroupMember,
  Health,
  IntermediateValue,
  Override,
  PersonalValue,
  Platform,
  ResolvedSetting,
  ResolveResponse,
  Role,
  Scope,
  SelectOption,
  ServerValue,
  Setting,
  SettingScope,
  SettingType,
  SettingValue,
  TypeConfig,
  ValueSource,
  WhoAmI,
} from "./types.ts";
