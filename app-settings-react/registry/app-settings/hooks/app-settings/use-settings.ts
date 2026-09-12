"use client";

/**
 * Reading a resolution.
 *
 * One resolution is one query, keyed by what it was resolved for, so a page
 * with thirty fields makes one request rather than thirty.
 */

import { useCallback } from "react";
import { useQuery, useQueryClient, type QueryKey, type UseQueryResult } from "@tanstack/react-query";
import { SettingsSnapshot, snapshotFrom } from "app-settings-js";

import { useAppSettingsConfig } from "@/registry/app-settings/lib/app-settings/context";
import { appSettingsKeys } from "@/registry/app-settings/lib/app-settings/keys";
import type {
  ResolvedSetting,
  ResolveQuery,
  ResolveResponse,
} from "@/registry/app-settings/lib/app-settings/types";
import type { SettingsQueryConfig } from "@/registry/app-settings/lib/app-settings/context";

/** What to resolve, and how hard to work at keeping it fresh. */
export interface UseSettingsOptions extends ResolveQuery {
  /** Overrides the provider's React Query settings for this resolution. */
  queryConfig?: SettingsQueryConfig;
  /** Skips the request entirely, for a panel that is not open yet. */
  enabled?: boolean;
}

/**
 * The query result, plus the parts a settings page reaches for.
 *
 * An intersection rather than an interface: React Query's result is a union of
 * its loading, error and success shapes, and extending a union is not a thing.
 */
export type UseSettingsResult = UseQueryResult<SettingsSnapshot, Error> & {
  /** The resolution, or undefined before the first one lands. */
  snapshot: SettingsSnapshot | undefined;
  /** Every setting the resolution returned, in the server's order. */
  settings: ResolvedSetting[];
  /** The cache key this resolution lives under, for manual cache work. */
  queryKey: QueryKey;
};

/** Resolves settings and keeps them fresh. */
export function useSettings(options: UseSettingsOptions = {}): UseSettingsResult {
  const config = useAppSettingsConfig();
  const transport = config.transport;

  // Neither of these is memoised: React Query hashes the key structurally, so a
  // fresh-but-equal key is the same cache entry, and a fresh `queryFn` closure
  // is what it expects on every render anyway.
  const query = mergeQuery(config.query, options);
  const queryKey = appSettingsKeys.resolution(query);

  // A snapshot wraps the response without copying it, but it is still a new
  // object each call, so the identity has to come from React Query's own
  // memoisation of `select` rather than from the function body.
  const select = useCallback((response: ResolveResponse) => snapshotFrom(response), []);

  const result = useQuery({
    queryKey,
    queryFn: ({ signal }) => transport.resolve(query, signal),
    select,
    staleTime: 30_000,
    ...config.queryConfig,
    ...options.queryConfig,
    enabled: options.enabled ?? true,
  });

  return {
    ...result,
    snapshot: result.data,
    settings: result.data ? [...result.data.settings] : [],
    queryKey,
  };
}

/**
 * The resolution alone, for a component that only reads.
 *
 * @example
 * const snapshot = useSettingsSnapshot();
 * if (snapshot?.boolean("beta.enabled")) return <BetaBanner />;
 */
export function useSettingsSnapshot(options: UseSettingsOptions = {}): SettingsSnapshot | undefined {
  return useSettings(options).snapshot;
}

/**
 * Refetches resolutions.
 *
 * With no argument every resolution is invalidated, which is what a bulk import
 * or an out-of-band change calls for. With one, only that resolution is.
 */
export function useRefreshSettings(): (query?: ResolveQuery) => Promise<void> {
  const queryClient = useQueryClient();
  const config = useAppSettingsConfig();

  return useCallback(
    async (query?: ResolveQuery) => {
      await queryClient.invalidateQueries({
        queryKey: query
          ? appSettingsKeys.resolution(mergeQuery(config.query, query))
          : appSettingsKeys.resolutions(),
      });
    },
    [queryClient, config.query],
  );
}

/** The provider's defaults with a hook's own overrides laid over them. */
export function mergeQuery(defaults: ResolveQuery, overrides: ResolveQuery = {}): ResolveQuery {
  return {
    userId: overrides.userId ?? defaults.userId,
    environment: overrides.environment ?? defaults.environment,
    platform: overrides.platform ?? defaults.platform,
    role: overrides.role ?? defaults.role,
    groupId: overrides.groupId ?? defaults.groupId,
  };
}
