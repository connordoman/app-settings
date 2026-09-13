/**
 * The contract between the App Settings components and wherever settings
 * actually live.
 *
 * Everything in this directory is transport-agnostic on purpose. The components
 * talk to a {@link SettingsTransport}, so the same UI renders whether it is
 * pointed straight at an App Settings deployment with an API key or at your own
 * API standing in front of one.
 */

import type {
  ResolvedSetting,
  ResolveResponse,
  SettingType,
  SettingValue,
  ValueSource,
  WhoAmI,
} from "app-settings-js";

export type {
  Override,
  ResolvedSetting,
  ResolveResponse,
  Scope,
  SelectOption,
  Setting,
  SettingScope,
  SettingType,
  SettingValue,
  TypeConfig,
  ValueSource,
  WhoAmI,
} from "app-settings-js";

/** Which layer a write lands in. */
export type SettingLayer = "server" | "personal" | "group";

/** What to resolve. Every field falls back to the provider's own default. */
export interface ResolveQuery {
  /** The user to resolve for. Omitted means the server layer alone. */
  userId?: string;
  environment?: string;
  platform?: string | string[];
  /** Resolve as this role rather than the API key's own. */
  role?: string;
  /** Groups applied without stored membership, for previewing a policy. */
  groupId?: string | string[];
}

/**
 * One pending change to one setting.
 *
 * `value: undefined` means "clear this layer" rather than "write undefined",
 * which is the distinction between falling back to the layer beneath and
 * storing an empty value.
 */
export interface WriteRequest {
  /** The setting being written, so a transport can use its id, name or type. */
  setting: ResolvedSetting;
  /** The new value, or `undefined` to clear the layer. */
  value: SettingValue | undefined;
  layer: SettingLayer;
  /** Required by the `personal` layer. */
  userId?: string;
  /** Required by the `group` layer. */
  groupId?: string;
  /** `group` only: whether the user may observe the override. */
  visible?: boolean;
  /** `group` only: whether the override beats the user's own value. */
  enforced?: boolean;
}

/** Where settings are read from and written to. */
export interface SettingsTransport {
  /** Reads one resolution. The response shape is the API's own. */
  resolve(query: ResolveQuery, signal?: AbortSignal): Promise<ResolveResponse>;
  /**
   * Applies one write. Omit it for a read-only board: the components disable
   * their controls rather than offering an edit that cannot land.
   */
  write?(request: WriteRequest, signal?: AbortSignal): Promise<void>;
  /**
   * Describes the calling API key. Omit it when the page cannot know: anything
   * gated on the key's scopes then defers to the server instead of disabling.
   */
  whoami?(signal?: AbortSignal): Promise<WhoAmI>;
}

/** A control that renders one setting's value, for the type-to-input registry. */
export interface SettingInputProps<T = SettingValue> {
  setting: ResolvedSetting;
  value: T;
  onValueChange: (value: T) => void;
  /** The control is present but cannot be changed — enforced, or read-only. */
  disabled?: boolean;
  /** A write is in flight; the value shown is optimistic. */
  pending?: boolean;
  /** Wired to the field's label, so clicking the label focuses the control. */
  id?: string;
  /** Wired to the field's description and error text. */
  "aria-describedby"?: string;
  /** Set when {@link validateValue} rejected the current draft. */
  "aria-invalid"?: boolean;
  className?: string;
}

/**
 * The props of a setting input, minus the ones it owns.
 *
 * Every input in this set accepts the primitive's own props too, so a caller
 * can pass `placeholder`, `autoFocus` or a `data-*` attribute straight through
 * without the component having to enumerate them.
 */
export type SettingInputComponentProps<Value, PrimitiveProps> = Omit<
  PrimitiveProps,
  keyof SettingInputProps<Value> | "value" | "defaultValue" | "onChange" | "children"
> &
  SettingInputProps<Value>;

/** A validation failure raised locally, before a request goes out. */
export interface ValueProblem {
  /** Written for the person at the keyboard. */
  message: string;
  /** Which rule rejected the value, for branching or styling. */
  rule:
    | "type"
    | "min"
    | "max"
    | "integer"
    | "min_length"
    | "max_length"
    | "pattern"
    | "option"
    | "json";
}

/** The state one setting is in, as the field chrome needs to read it. */
export interface SettingStatus {
  source: ValueSource;
  type: SettingType;
  /** A group override shaped this value, and the user may know about it. */
  overridden: boolean;
  /** A group policy holds this value in place; writing it would do nothing. */
  enforced: boolean;
  /** No layer, not even the definition's default, supplied a value. */
  unset: boolean;
}
