import { parseInstant } from "./datetime.js";
import { AppSettingsError } from "./errors.js";
import type { Override, ResolveResponse, ResolvedSetting, SelectOption, SettingValue } from "./types.js";

/**
 * A resolution, wrapped so reading a value is a one-liner.
 *
 * The instance is immutable and its identity only changes when the underlying
 * data does, which is exactly what a UI framework needs to decide whether to
 * re-render. {@link SettingsSnapshot.with} produces a new snapshot rather than
 * mutating this one.
 */
export class SettingsSnapshot {
  /** Every setting the resolution returned, in the server's order. */
  readonly settings: readonly ResolvedSetting[];
  /** The environment this was resolved in. */
  readonly environment: string;
  /** The platforms the resolution was filtered to, if any. */
  readonly platforms: readonly string[];
  /** The user this was resolved for, absent for a server resolution. */
  readonly userId?: string;
  /** The role the resolution ran as. */
  readonly role: string;
  /** When the server produced this. */
  readonly resolvedAt: Date;

  readonly #byName: ReadonlyMap<string, ResolvedSetting>;

  constructor(response: ResolveResponse) {
    this.settings = Object.freeze([...(response.settings ?? [])]);
    this.environment = response.environment;
    this.platforms = Object.freeze([...(response.platforms ?? [])]);
    this.userId = response.user_id;
    this.role = response.role;
    this.resolvedAt = parseInstant(response.resolved_at) ?? new Date();
    this.#byName = new Map(this.settings.map((setting) => [setting.name, setting]));
    Object.freeze(this);
  }

  /** The names of every setting present, useful for iterating a settings page. */
  get names(): string[] {
    return [...this.#byName.keys()];
  }

  /** How many settings the resolution returned. */
  get size(): number {
    return this.settings.length;
  }

  /** Whether a setting is present at all. Absent means the role cannot see it. */
  has(name: string): boolean {
    return this.#byName.has(name);
  }

  /** The whole resolved setting, or `undefined` if this role cannot see it. */
  get(name: string): ResolvedSetting | undefined {
    return this.#byName.get(name);
  }

  /**
   * The effective value, untyped.
   *
   * `null` is returned both for a setting whose source is `UNSET` and for one
   * genuinely set to null; {@link SettingsSnapshot.isSet} tells them apart.
   */
  value(name: string): SettingValue {
    return this.#byName.get(name)?.value ?? null;
  }

  /** Whether any layer, including the definition's default, supplied a value. */
  isSet(name: string): boolean {
    const setting = this.#byName.get(name);
    return setting !== undefined && setting.source !== "UNSET";
  }

  /** Which layer the effective value came from. */
  source(name: string): ResolvedSetting["source"] | undefined {
    return this.#byName.get(name)?.source;
  }

  /**
   * A `BOOLEAN` value.
   *
   * @param fallback Returned when the setting is invisible to this role or unset.
   * @throws {AppSettingsError} with code `type_mismatch` if the setting holds
   * something other than a boolean, which means the wrong name was asked for.
   */
  boolean(name: string, fallback = false): boolean {
    return this.#typed(name, fallback, "boolean", (value) => typeof value === "boolean");
  }

  /** A `NUMBER` value. See {@link SettingsSnapshot.boolean} for the rules. */
  number(name: string, fallback = 0): number {
    return this.#typed(name, fallback, "number", (value) => typeof value === "number" && Number.isFinite(value));
  }

  /** A `STRING` or single-choice `SELECT` value. */
  string(name: string, fallback = ""): string {
    return this.#typed(name, fallback, "string", (value) => typeof value === "string");
  }

  /** A `DATETIME` value, already parsed. */
  date(name: string, fallback?: Date): Date | undefined {
    const value = this.#present(name);
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string") throw this.#mismatch(name, "a date-time string", value);
    return parseInstant(value);
  }

  /**
   * A multi-choice `SELECT` value. A single-choice value is returned as a
   * one-element array, so a caller need not branch on `multiple`.
   */
  list<T = SettingValue>(name: string, fallback: T[] = []): T[] {
    const value = this.#present(name);
    if (value === undefined || value === null) return fallback;
    return (Array.isArray(value) ? value : [value]) as T[];
  }

  /**
   * A `JSON` value, or any value at all, cast to the caller's type.
   *
   * Nothing is validated here: the server has already checked the value against
   * the setting's own rules, and a `JSON` setting has none beyond being JSON.
   */
  json<T = SettingValue>(name: string, fallback?: T): T {
    const value = this.#present(name);
    return (value === undefined || value === null ? fallback : value) as T;
  }

  /** The choices a `SELECT` offers, for rendering a picker. */
  options(name: string): SelectOption[] {
    return this.#byName.get(name)?.type_config?.options ?? [];
  }

  /** The group override that shaped this value, if one did. */
  override(name: string): Override | undefined {
    return this.#byName.get(name)?.override;
  }

  /**
   * The override to tell the user about.
   *
   * An override marked `visible: false` is deliberately withheld: the user is
   * not meant to observe that anything was overridden, so a UI should read this
   * rather than {@link SettingsSnapshot.override}.
   */
  visibleOverride(name: string): Override | undefined {
    const override = this.override(name);
    return override?.visible ? override : undefined;
  }

  /**
   * Whether a group policy is holding this value in place.
   *
   * This is the check for disabling a control: an enforced override beats
   * whatever the user chooses, so writing to it would appear to do nothing.
   */
  isEnforced(name: string): boolean {
    return this.override(name)?.enforced === true;
  }

  /** Settings the user may actually change: personal scope, not enforced. */
  editable(): ResolvedSetting[] {
    return this.settings.filter(
      (setting) => setting.scope === "PERSONAL" && setting.override?.enforced !== true,
    );
  }

  /** Every setting matching a predicate, for grouping a settings page. */
  filter(predicate: (setting: ResolvedSetting) => boolean): ResolvedSetting[] {
    return this.settings.filter(predicate);
  }

  /** A plain `{ name: value }` object, handy for logging or a feature-flag map. */
  toObject(): Record<string, SettingValue> {
    return Object.fromEntries(this.settings.map((setting) => [setting.name, setting.value]));
  }

  /** The underlying response, for anything this class does not cover. */
  toJSON(): ResolveResponse {
    return {
      environment: this.environment,
      platforms: [...this.platforms],
      user_id: this.userId,
      role: this.role,
      settings: [...this.settings],
      resolved_at: this.resolvedAt.toISOString(),
    };
  }

  /**
   * A new snapshot with one value replaced, leaving this one untouched.
   *
   * Used for an optimistic update: show the new value at once, then reconcile
   * with whatever the next resolution says.
   */
  with(name: string, value: SettingValue, source: ResolvedSetting["source"] = "PERSONAL"): SettingsSnapshot {
    if (!this.#byName.has(name)) return this;

    return new SettingsSnapshot({
      ...this.toJSON(),
      settings: this.settings.map((setting) =>
        setting.name === name ? { ...setting, value, source } : setting,
      ),
    });
  }

  [Symbol.iterator](): IterableIterator<ResolvedSetting> {
    return this.settings[Symbol.iterator]();
  }

  /** The value when one is present, else undefined. Null reads as absent. */
  #present(name: string): SettingValue | undefined {
    const setting = this.#byName.get(name);
    if (setting === undefined || setting.source === "UNSET") return undefined;
    return setting.value ?? undefined;
  }

  #typed<T>(name: string, fallback: T, expected: string, matches: (value: SettingValue) => boolean): T {
    const value = this.#present(name);
    if (value === undefined) return fallback;
    if (!matches(value)) throw this.#mismatch(name, `a ${expected}`, value);
    return value as T;
  }

  #mismatch(name: string, expected: string, value: SettingValue): AppSettingsError {
    const declared = this.#byName.get(name)?.type;
    return new AppSettingsError(
      `setting "${name}" is declared ${declared} and holds ${describe(value)}, not ${expected}`,
      { code: "type_mismatch" },
    );
  }
}

/** Builds a snapshot from a raw resolution response. */
export function snapshotFrom(response: ResolveResponse): SettingsSnapshot {
  return new SettingsSnapshot(response);
}

function describe(value: SettingValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
