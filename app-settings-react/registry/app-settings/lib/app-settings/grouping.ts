/**
 * Turning a flat resolution into the sections a settings page renders.
 *
 * A resolution arrives in the server's order, which is stable but not
 * meaningful to a reader. These helpers are what `<SettingList>` uses; they are
 * exported so a page can lay the same groups out its own way.
 */

import type { ResolvedSetting } from "@/registry/app-settings/lib/app-settings/types";

/** One rendered section. */
export interface SettingGroup {
  /** A stable key, also used as the heading when no `title` is given. */
  key: string;
  title: string;
  settings: ResolvedSetting[];
}

/**
 * How to split settings into sections.
 *
 * `prefix` reads a dotted name — `billing.currency` lands in "billing" — which
 * is how most deployments already organise their settings.
 */
export type GroupBy =
  | "none"
  | "prefix"
  | "platform"
  | "role"
  | "scope"
  | ((setting: ResolvedSetting) => string);

export interface GroupSettingsOptions {
  by?: GroupBy;
  /** The heading for settings the grouper returns nothing for. */
  fallbackTitle?: string;
  /** Overrides the heading for a given key. */
  titles?: Record<string, string>;
  /** Orders the sections. Unlisted keys keep their first-seen order, after these. */
  order?: string[];
}

/** Splits a resolution into sections, preserving the server's order within each. */
export function groupSettings(
  settings: readonly ResolvedSetting[],
  options: GroupSettingsOptions = {},
): SettingGroup[] {
  const { by = "none", fallbackTitle = "General", titles = {}, order = [] } = options;
  const grouper = resolveGrouper(by);
  const groups = new Map<string, SettingGroup>();

  for (const setting of settings) {
    const key = grouper(setting) || "";
    const existing = groups.get(key);
    if (existing) {
      existing.settings.push(setting);
      continue;
    }
    groups.set(key, {
      key: key || "__general__",
      title: titles[key] ?? (key ? titleCase(key) : fallbackTitle),
      settings: [setting],
    });
  }

  const sections = [...groups.values()];
  if (order.length === 0) return sections;

  const rank = new Map(order.map((key, index) => [key, index]));
  return sections.sort(
    (a, b) => (rank.get(a.key) ?? order.length) - (rank.get(b.key) ?? order.length),
  );
}

/** The name with its grouping prefix removed, for a heading-relative label. */
export function shortName(setting: ResolvedSetting): string {
  const index = setting.name.lastIndexOf(".");
  return index === -1 ? setting.name : setting.name.slice(index + 1);
}

/** A readable label for a setting, from its dotted or snake-cased name. */
export function settingLabel(setting: ResolvedSetting): string {
  return titleCase(shortName(setting));
}

function resolveGrouper(by: GroupBy): (setting: ResolvedSetting) => string {
  if (typeof by === "function") return by;

  switch (by) {
    case "prefix":
      return (setting) => {
        const index = setting.name.indexOf(".");
        return index === -1 ? "" : setting.name.slice(0, index);
      };
    case "platform":
      return (setting) => setting.platform;
    case "role":
      return (setting) => setting.role;
    case "scope":
      return (setting) => setting.scope;
    default:
      return () => "";
  }
}

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
