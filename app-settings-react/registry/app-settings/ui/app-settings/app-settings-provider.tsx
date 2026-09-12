"use client";

import * as React from "react";
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
} from "@tanstack/react-query";

import {
  AppSettingsContext,
  type AppSettingsConfig,
  type SettingsQueryConfig,
} from "@/registry/app-settings/lib/app-settings/context";
import type {
  ResolveQuery,
  SettingLayer,
  SettingsTransport,
} from "@/registry/app-settings/lib/app-settings/types";

export interface AppSettingsProviderProps extends ResolveQuery {
  /**
   * Where settings come from.
   *
   * `transportFromClient(client)` for a board that holds an API key;
   * `createHttpTransport({ ... })` for one that goes through your own API.
   */
  transport: SettingsTransport;
  /**
   * Which layer writes land in.
   *
   * Defaults to `personal` when a `userId` is given and `server` otherwise,
   * which is the right guess for a user's own preferences page and for an
   * operator's switchboard respectively.
   */
  layer?: SettingLayer;
  /** The group a `group`-layer write targets. */
  writeGroupId?: string;
  /** `group` layer: whether the user may observe the override. */
  visible?: boolean;
  /** `group` layer: whether the override beats the user's own value. */
  enforced?: boolean;
  /** Renders every control disabled, for a board someone may only look at. */
  readOnly?: boolean;
  /** Check values against `type_config` before writing. On by default. */
  validate?: boolean;
  /** React Query defaults for every resolution under this provider. */
  queryConfig?: SettingsQueryConfig;
  /**
   * A `QueryClient` to use when the app does not already have one.
   *
   * If a `QueryClientProvider` is already above this component, that client is
   * used and this is ignored. Otherwise one is created so the components work
   * in an app that has not adopted React Query yet.
   */
  queryClient?: QueryClient;
  children?: React.ReactNode;
}

/**
 * Configures every App Settings hook and component below it.
 *
 * @example
 * const transport = transportFromClient(
 *   new AppSettingsClient({ baseUrl, apiKey, environment: "production" }),
 * );
 *
 * <AppSettingsProvider transport={transport} layer="server">
 *   <SettingList groupBy="prefix" />
 * </AppSettingsProvider>
 */
export function AppSettingsProvider({
  transport,
  userId,
  environment,
  platform,
  role,
  groupId,
  layer,
  writeGroupId,
  visible,
  enforced,
  readOnly = false,
  validate = true,
  queryConfig,
  queryClient,
  children,
}: AppSettingsProviderProps) {
  // Arrays and the query config are commonly written inline, so the identity of
  // `config` is pinned to their contents rather than to the object passed in.
  const platformSeed = JSON.stringify(platform ?? null);
  const groupSeed = JSON.stringify(groupId ?? null);
  const queryConfigSeed = JSON.stringify(queryConfig ?? null);

  const config = React.useMemo<AppSettingsConfig>(
    () => ({
      transport,
      query: { userId, environment, platform, role, groupId },
      layer: layer ?? (userId ? "personal" : "server"),
      writeGroupId: writeGroupId ?? firstOf(groupId),
      visible,
      enforced,
      readOnly,
      validate,
      queryConfig: queryConfig ?? {},
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seeds stand in for the inline array and object props above.
    [
      transport,
      userId,
      environment,
      role,
      platformSeed,
      groupSeed,
      layer,
      writeGroupId,
      visible,
      enforced,
      readOnly,
      validate,
      queryConfigSeed,
    ],
  );

  return (
    <AppSettingsContext.Provider value={config}>
      <EnsureQueryClient client={queryClient}>{children}</EnsureQueryClient>
    </AppSettingsContext.Provider>
  );
}

/**
 * Wraps the tree in a `QueryClientProvider` only when the app has none.
 *
 * Mounting a second one would give these components their own cache, which is
 * the bug where a write here never updates a list rendered by the app's own
 * query elsewhere.
 */
function EnsureQueryClient({
  client,
  children,
}: {
  client?: QueryClient;
  children?: React.ReactNode;
}) {
  const existing = React.useContext(QueryClientContext);
  const [fallback] = React.useState(() => client ?? new QueryClient());

  if (existing) return <>{children}</>;
  return <QueryClientProvider client={client ?? fallback}>{children}</QueryClientProvider>;
}

function firstOf(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}
