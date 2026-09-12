/**
 * The configuration every hook and component reads.
 *
 * It is deliberately a plain context rather than a store: the transport and the
 * defaults change rarely, and React Query already owns the part that changes
 * often. `<AppSettingsProvider>` in `app-settings-provider.tsx` is what fills
 * this in.
 */

import { createContext, useContext } from "react";

import type {
  ResolveQuery,
  SettingLayer,
  SettingsTransport,
} from "@/registry/app-settings/lib/app-settings/types";

/** Per-query React Query options a caller may override. */
export interface SettingsQueryConfig {
  /** How long a resolution is considered fresh. Defaults to 30 seconds. */
  staleTime?: number;
  gcTime?: number;
  /** Re-resolve on an interval. Off by default. */
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean;
  refetchOnMount?: boolean | "always";
  retry?: number | boolean;
}

export interface AppSettingsConfig {
  transport: SettingsTransport;
  /** Applied to every resolution a hook makes, unless the hook overrides it. */
  query: ResolveQuery;
  /** Which layer writes land in. */
  layer: SettingLayer;
  /** The group a `group`-layer write targets. */
  writeGroupId?: string;
  /** `group` layer: whether the user may observe the override. */
  visible?: boolean;
  /** `group` layer: whether the override beats the user's own value. */
  enforced?: boolean;
  /** Renders every control disabled, whatever the transport can do. */
  readOnly: boolean;
  /** Check values against `type_config` before writing. On by default. */
  validate: boolean;
  queryConfig: SettingsQueryConfig;
}

export const AppSettingsContext = createContext<AppSettingsConfig | null>(null);

/**
 * The configuration from the nearest provider.
 *
 * @throws if there is no `<AppSettingsProvider>` above this component, which is
 * a wiring mistake rather than a state worth rendering.
 */
export function useAppSettingsConfig(): AppSettingsConfig {
  const config = useContext(AppSettingsContext);
  if (!config) {
    throw new Error(
      "useAppSettingsConfig must be used inside <AppSettingsProvider>. " +
        "Wrap your settings page in it and give it a transport.",
    );
  }
  return config;
}

/** The configuration, or null outside a provider, for an optional integration. */
export function useOptionalAppSettingsConfig(): AppSettingsConfig | null {
  return useContext(AppSettingsContext);
}
