/**
 * Reading, checking and rendering setting values.
 *
 * Nothing here touches React or the network, which is what makes it testable
 * and what makes the components thin. The validation mirrors the rules the
 * server enforces in `type_config`, so a bad value is caught under the input
 * rather than after a round trip — the server is still the authority.
 */

import { isInstant, parseInstant, toDateTimeLocal } from "app-settings-js";

import type {
  Override,
  ResolvedSetting,
  ResolveResponse,
  SelectOption,
  SettingLayer,
  SettingStatus,
  SettingValue,
  TypeConfig,
  ValueProblem,
  ValueSource,
} from "@/registry/app-settings/lib/app-settings/types";

/** How each layer reads in a UI. */
export const SOURCE_LABELS: Record<ValueSource, string> = {
  UNSET: "Not set",
  DEFAULT: "Default",
  SERVER: "Server",
  INTERMEDIATE: "Group",
  PERSONAL: "Personal",
};

/** A human label for the layer an effective value came from. */
export function sourceLabel(source: ValueSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Everything the field chrome needs to know about one setting's state. */
export function settingStatus(setting: ResolvedSetting): SettingStatus {
  const override = setting.override;
  return {
    source: setting.source,
    type: setting.type,
    overridden: override?.visible === true,
    enforced: override?.enforced === true,
    unset: setting.source === "UNSET",
  };
}

/** Whether a group policy is holding this value in place. */
export function isEnforced(setting: ResolvedSetting): boolean {
  return setting.override?.enforced === true;
}

/**
 * The override worth telling the user about.
 *
 * An override marked `visible: false` is deliberately withheld: the user is not
 * meant to observe that anything was overridden.
 */
export function visibleOverride(setting: ResolvedSetting): Override | undefined {
  return setting.override?.visible ? setting.override : undefined;
}

/** A one-line explanation of an override, for a badge title or helper text. */
export function describeOverride(override: Override): string {
  const verb = override.enforced ? "enforced by" : "set by";
  const replaced =
    override.enforced && override.replaced_value !== undefined
      ? `, replacing ${JSON.stringify(override.replaced_value)}`
      : "";
  return `This value is ${verb} group ${override.group_id}${replaced}.`;
}

/** The value a control should start from, with a type-appropriate empty. */
export function controlValue(setting: ResolvedSetting): SettingValue {
  if (setting.value !== null && setting.value !== undefined) return setting.value;
  return emptyValue(setting);
}

/** The value that stands for "nothing chosen yet" for a given type. */
export function emptyValue(setting: ResolvedSetting): SettingValue {
  switch (setting.type) {
    case "BOOLEAN":
      return false;
    case "NUMBER":
      return setting.type_config?.min ?? 0;
    case "STRING":
    case "DATETIME":
      return "";
    case "SELECT":
      return isMultiSelect(setting) ? [] : null;
    case "JSON":
      return null;
    default:
      return null;
  }
}

/** Whether a SELECT holds an array of options rather than one. */
export function isMultiSelect(setting: ResolvedSetting): boolean {
  return setting.type === "SELECT" && setting.type_config?.multiple === true;
}

/** The step a NUMBER input should use, honouring an `integer` constraint. */
export function numberStep(config: TypeConfig | undefined): number | "any" {
  return config?.integer ? 1 : "any";
}

/** One SELECT choice, with a string token safe to hand a `<Select>`. */
export interface SettingOption {
  label: string;
  value: SettingValue;
  /** A stable string form of `value`, since select elements only speak strings. */
  token: string;
}

/** The choices a SELECT offers. Empty for every other type. */
export function selectOptions(setting: ResolvedSetting): SettingOption[] {
  const options = setting.type_config?.options ?? [];
  return options.map(([label, value]: SelectOption) => ({
    label,
    value,
    token: optionToken(value),
  }));
}

/** The string form of an option value, used as a select token and React key. */
export function optionToken(value: SettingValue): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

/** The option a token came from, so a select change recovers the real value. */
export function optionFromToken(
  setting: ResolvedSetting,
  token: string,
): SettingOption | undefined {
  return selectOptions(setting).find((option) => option.token === token);
}

/** A multi-select value as an array, whatever shape the server sent. */
export function asArray(value: SettingValue): SettingValue[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Checks a value against the setting's own rules.
 *
 * Returns `null` when the value is acceptable. These are the same rules the
 * server applies; running them here buys immediate feedback, not authority.
 */
export function validateValue(
  setting: ResolvedSetting,
  value: SettingValue,
): ValueProblem | null {
  const config = setting.type_config ?? {};

  switch (setting.type) {
    case "BOOLEAN":
      return typeof value === "boolean" ? null : problem("type", "Must be true or false.");

    case "NUMBER": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return problem("type", "Must be a number.");
      }
      if (config.integer && !Number.isInteger(value)) {
        return problem("integer", "Must be a whole number.");
      }
      if (config.min !== undefined && value < config.min) {
        return problem("min", `Must be ${config.min} or more.`);
      }
      if (config.max !== undefined && value > config.max) {
        return problem("max", `Must be ${config.max} or less.`);
      }
      return null;
    }

    case "STRING": {
      if (typeof value !== "string") return problem("type", "Must be text.");
      if (config.min_length !== undefined && value.length < config.min_length) {
        return problem("min_length", `Must be at least ${config.min_length} characters.`);
      }
      if (config.max_length !== undefined && value.length > config.max_length) {
        return problem("max_length", `Must be at most ${config.max_length} characters.`);
      }
      if (config.pattern && !matchesPattern(value, config.pattern)) {
        return problem("pattern", `Must match ${config.pattern}.`);
      }
      return null;
    }

    case "DATETIME":
      return isInstant(value)
        ? null
        : problem("type", "Must be a date and time with a UTC offset.");

    case "SELECT": {
      const tokens = new Set(selectOptions(setting).map((option) => option.token));
      const chosen = isMultiSelect(setting) ? asArray(value) : [value];
      if (isMultiSelect(setting) && !Array.isArray(value)) {
        return problem("type", "Must be a list of choices.");
      }
      for (const candidate of chosen) {
        if (!tokens.has(optionToken(candidate))) {
          return problem("option", "Must be one of the offered choices.");
        }
      }
      return null;
    }

    case "JSON":
      return isJsonSerialisable(value) ? null : problem("json", "Must be JSON.");

    default:
      return null;
  }
}

/** Parses what a NUMBER input produced, without guessing at empty text. */
export function parseNumberInput(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parses a JSON textarea, reporting the parser's own complaint. */
export function parseJsonInput(
  raw: string,
): { ok: true; value: SettingValue } | { ok: false; problem: ValueProblem } {
  if (raw.trim() === "") return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(raw) as SettingValue };
  } catch (caught) {
    return {
      ok: false,
      problem: problem("json", caught instanceof Error ? caught.message : "Invalid JSON."),
    };
  }
}

/** Renders a JSON value for a textarea, stable enough to edit in place. */
export function formatJsonInput(value: SettingValue): string {
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/** Renders an instant for `<input type="datetime-local">`, in the local zone. */
export function formatDateTimeInput(value: SettingValue, timeZone?: string): string {
  if (typeof value !== "string" || value === "") return "";
  const parsed = parseInstant(value);
  return parsed ? toDateTimeLocal(parsed, timeZone) : "";
}

/**
 * A short, readable rendering of any value, for a summary row or a diff.
 *
 * A DATETIME is shown in the reader's own zone; everything else is shown as it
 * is stored, because a settings board is where the stored value matters.
 */
export function formatValue(setting: ResolvedSetting, value = setting.value): string {
  if (setting.source === "UNSET" && value === null) return "—";
  if (value === null || value === undefined) return "null";

  switch (setting.type) {
    case "BOOLEAN":
      return value ? "On" : "Off";
    case "DATETIME": {
      const parsed = typeof value === "string" ? parseInstant(value) : undefined;
      return parsed ? parsed.toLocaleString() : String(value);
    }
    case "SELECT": {
      const options = selectOptions(setting);
      const labelFor = (candidate: SettingValue) =>
        options.find((option) => option.token === optionToken(candidate))?.label ??
        String(candidate);
      return isMultiSelect(setting)
        ? asArray(value).map(labelFor).join(", ") || "—"
        : labelFor(value);
    }
    case "JSON":
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** Whether two values are the same as far as a write is concerned. */
export function valuesEqual(a: SettingValue, b: SettingValue): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" && typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function problem(rule: ValueProblem["rule"], message: string): ValueProblem {
  return { rule, message };
}

/**
 * The server anchors patterns to the whole value and reads them as RE2. A
 * pattern RE2 accepts but JavaScript does not is treated as passing here, so a
 * local check never blocks a value the server would take.
 */
function matchesPattern(value: string, pattern: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, "u").test(value);
  } catch {
    return true;
  }
}

function isJsonSerialisable(value: SettingValue): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      try {
        JSON.stringify(value);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/**
 * A resolution with one value replaced, leaving the original untouched.
 *
 * This is the optimistic update: show the new value at once, then let the next
 * resolution confirm it. A setting the resolution does not contain is left
 * alone rather than invented.
 */
export function withValue(
  response: ResolveResponse,
  name: string,
  value: SettingValue,
  source: ValueSource = "PERSONAL",
): ResolveResponse {
  let changed = false;
  const settings = (response.settings ?? []).map((setting) => {
    if (setting.name !== name) return setting;
    changed = true;
    return { ...setting, value, source };
  });

  return changed ? { ...response, settings } : response;
}

/** The layer a write shows up as, for an optimistic value's `source`. */
export function sourceForLayer(layer: SettingLayer): ValueSource {
  switch (layer) {
    case "personal":
      return "PERSONAL";
    case "group":
      return "INTERMEDIATE";
    case "server":
      return "SERVER";
    default:
      return "SERVER";
  }
}
