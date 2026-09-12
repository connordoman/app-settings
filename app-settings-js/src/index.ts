/**
 * A TypeScript SDK for the App Settings API.
 *
 * It has no dependencies and runs anywhere `fetch` does: browsers, Node 18+,
 * Bun, Deno and edge runtimes.
 */

export { AppSettingsClient } from "./client.js";
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
} from "./client.js";

export { SettingsSnapshot, snapshotFrom } from "./snapshot.js";

export { createSettingsStore } from "./store.js";
export type { SettingsState, SettingsStore, SettingsStoreOptions } from "./store.js";

export {
  AppSettingsError,
  isConflict,
  isForbidden,
  isInvalidRequest,
  isNotFound,
  isUnauthorized,
} from "./errors.js";
export type { AnyErrorCode, ClientErrorCode } from "./errors.js";

export { isInstant, localToInstant, parseInstant, toDateTimeLocal, toInstant } from "./datetime.js";

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
} from "./types.js";
