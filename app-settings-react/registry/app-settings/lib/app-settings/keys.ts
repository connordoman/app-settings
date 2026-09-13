/**
 * Query keys for the App Settings cache.
 *
 * Every key is derived from the resolution query, so two components asking for
 * the same resolution share one request, and a write can invalidate exactly the
 * resolutions it could have changed.
 */

import type { QueryKey } from "@tanstack/react-query";

import type { ResolveQuery } from "@/registry/app-settings/lib/app-settings/types";

export const appSettingsKeys = {
  /** Everything this library caches. Invalidate to refetch all of it. */
  all: () => ["app-settings"] as const,

  /** Every resolution, whatever it was resolved for. */
  resolutions: () => [...appSettingsKeys.all(), "resolution"] as const,

  /** One resolution. Field order and array order never affect the key. */
  resolution: (query: ResolveQuery = {}): QueryKey =>
    [...appSettingsKeys.resolutions(), normaliseQuery(query)] as const,

  /** Setting definitions, for an editor that lists more than a resolution does. */
  definitions: (filters: Record<string, unknown> = {}): QueryKey =>
    [...appSettingsKeys.all(), "definitions", filters] as const,

  /** The calling API key, as the transport describes it. */
  whoami: () => [...appSettingsKeys.all(), "whoami"] as const,
};

/**
 * A canonical form of a query, so `{ userId: "a" }` and
 * `{ environment: undefined, userId: "a" }` are one cache entry rather than two.
 */
export function normaliseQuery(query: ResolveQuery): Record<string, string | string[]> {
  const entries: [string, string | string[]][] = [];

  if (query.userId) entries.push(["userId", query.userId]);
  if (query.environment) entries.push(["environment", query.environment]);
  if (query.role) entries.push(["role", query.role]);

  const platform = sortedList(query.platform);
  if (platform.length) entries.push(["platform", platform]);

  const groupId = sortedList(query.groupId);
  if (groupId.length) entries.push(["groupId", groupId]);

  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function sortedList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return [...(Array.isArray(value) ? value : [value])].sort();
}
