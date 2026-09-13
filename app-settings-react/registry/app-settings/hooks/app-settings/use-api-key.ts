"use client";

/**
 * Reading what the calling API key may do.
 *
 * The key is described by the transport's optional `whoami`. A transport
 * without one cannot say, so the hooks here report the key as unknown and leave
 * the decision to the server rather than disabling everything.
 */

import { useQuery } from "@tanstack/react-query";

import { useAppSettingsConfig } from "@/registry/app-settings/lib/app-settings/context";
import { appSettingsKeys } from "@/registry/app-settings/lib/app-settings/keys";
import {
  canCreateSetting,
  type CreateSettingRequirements,
  type Permission,
} from "@/registry/app-settings/lib/app-settings/permissions";
import type {
  Scope,
  SettingLayer,
  WhoAmI,
} from "@/registry/app-settings/lib/app-settings/types";

export interface UseApiKeyResult {
  /** The key, or undefined while loading, on failure, or when the transport cannot say. */
  key: WhoAmI | undefined;
  /** Whether the transport can describe the key at all. */
  supported: boolean;
  isLoading: boolean;
  error: Error | null;
}

/** Describes the API key behind the provider's transport. */
export function useApiKey(): UseApiKeyResult {
  const { transport } = useAppSettingsConfig();
  const whoami = transport.whoami?.bind(transport);

  const result = useQuery({
    queryKey: appSettingsKeys.whoami(),
    queryFn: ({ signal }) => (whoami as NonNullable<typeof whoami>)(signal),
    // A key's scopes change when it is re-minted, not while a page is open.
    staleTime: 5 * 60_000,
    enabled: whoami !== undefined,
  });

  return {
    key: result.data,
    supported: whoami !== undefined,
    isLoading: whoami !== undefined && result.isLoading,
    error: result.error,
  };
}

export interface UseCreateSettingPermissionOptions {
  /** Checks these scopes instead of asking the transport, e.g. from your own session. */
  scopes?: readonly Scope[];
  /** Tightens what each layer requires. See `defaultCreateSettingRequirements`. */
  requirements?: Partial<CreateSettingRequirements>;
}

export interface CreateSettingPermission extends Permission {
  /** The key's scopes are still loading; `allowed` is false until they land. */
  pending: boolean;
  /** No scopes could be read, so `allowed` defers to the server. */
  unknown: boolean;
}

/** Whether the current key may create a setting in a layer. */
export function useCreateSettingPermission(
  layer: SettingLayer,
  options: UseCreateSettingPermissionOptions = {},
): CreateSettingPermission {
  const { key, supported, isLoading } = useApiKey();
  const { readOnly } = useAppSettingsConfig();

  if (readOnly) return { allowed: false, missing: [], pending: false, unknown: false };

  const scopes = options.scopes ?? key?.scopes;
  if (scopes) {
    return { ...canCreateSetting(scopes, layer, options.requirements), pending: false, unknown: false };
  }

  if (supported && isLoading) return { allowed: false, missing: [], pending: true, unknown: false };
  return { allowed: true, missing: [], pending: false, unknown: true };
}
