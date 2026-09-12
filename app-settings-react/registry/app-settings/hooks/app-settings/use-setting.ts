"use client";

/**
 * Reading and writing one setting.
 *
 * A write is applied to the cached resolution before the request goes out and
 * rolled back if it fails, so a control feels instant without ever lying: an
 * enforced value is left where it is, because a group policy would put it back.
 */

import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAppSettingsConfig } from "@/registry/app-settings/lib/app-settings/context";
import {
  isEnforced,
  settingStatus,
  sourceForLayer,
  validateValue,
  withValue,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  ResolvedSetting,
  ResolveResponse,
  SettingLayer,
  SettingStatus,
  SettingValue,
  ValueProblem,
  WriteRequest,
} from "@/registry/app-settings/lib/app-settings/types";
import {
  useSettings,
  type UseSettingsOptions,
} from "@/registry/app-settings/hooks/app-settings/use-settings";

/** Where a write should land. Every field defaults to the provider's own. */
export interface WriteOptions {
  layer?: SettingLayer;
  /** The user whose personal value is written. Defaults to the resolved user. */
  writeUserId?: string;
  /** The group whose override is written, for the `group` layer. */
  writeGroupId?: string;
  /** `group` layer: whether the user may observe the override. */
  visible?: boolean;
  /** `group` layer: whether the override beats the user's own value. */
  enforced?: boolean;
  /** Check the value against `type_config` before writing. On by default. */
  validate?: boolean;
}

export interface UseSettingOptions extends UseSettingsOptions, WriteOptions {
  /** Called after a write lands and the resolution has been invalidated. */
  onWritten?: (value: SettingValue | undefined, setting: ResolvedSetting) => void;
  /** Called when a write fails, or when local validation rejected the value. */
  onError?: (error: Error) => void;
}

export interface UseSettingResult {
  /** The resolved setting, or undefined while loading or if the role cannot see it. */
  setting: ResolvedSetting | undefined;
  /** The effective value, already optimistic if a write is in flight. */
  value: SettingValue;
  /** Source, override and unset state, for the field chrome. */
  status: SettingStatus | undefined;
  /** The first resolution has not arrived yet. */
  isLoading: boolean;
  /** The resolution failed. */
  error: Error | null;
  /** A write is in flight. */
  isWriting: boolean;
  /** The last write's failure, cleared by the next attempt. */
  writeError: Error | null;
  /** Why the last value offered to {@link UseSettingResult.set} was rejected. */
  problem: ValueProblem | null;
  /** Whether a control should be editable at all. */
  canWrite: boolean;
  /**
   * Writes a value. Resolves `true` when it landed, `false` when local
   * validation rejected it or the request failed — never rejects, so a control's
   * change handler needs no try/catch.
   */
  set: (value: SettingValue) => Promise<boolean>;
  /** Clears this layer, falling back to whatever lies beneath it. */
  clear: () => Promise<boolean>;
  /** Re-resolves, discarding anything optimistic. */
  refresh: () => Promise<void>;
}

/**
 * One setting, ready to bind to a control.
 *
 * @example
 * const { value, set, canWrite } = useSetting("signups.enabled");
 * <Switch checked={value === true} onCheckedChange={set} disabled={!canWrite} />
 */
export function useSetting(name: string, options: UseSettingOptions = {}): UseSettingResult {
  const config = useAppSettingsConfig();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<ValueProblem | null>(null);

  const { snapshot, queryKey, isLoading, error } = useSettings(options);
  const setting = snapshot?.get(name);

  const layer = options.layer ?? config.layer;
  const shouldValidate = options.validate ?? config.validate;
  const writable = config.transport.write !== undefined && !config.readOnly;

  const mutation = useMutation<void, Error, SettingValue | undefined, { previous?: ResolveResponse }>({
    mutationFn: async (value) => {
      if (!setting) throw new Error(`no setting named "${name}" is present in this resolution`);
      const write = config.transport.write;
      if (!write) throw new Error("this transport is read-only: it has no write()");

      const request: WriteRequest = {
        setting,
        value,
        layer,
        userId: layer === "personal" ? (options.writeUserId ?? options.userId ?? config.query.userId) : undefined,
        groupId: layer === "group" ? (options.writeGroupId ?? config.writeGroupId) : undefined,
        visible: options.visible ?? config.visible,
        enforced: options.enforced ?? config.enforced,
      };
      await write(request);
    },

    onMutate: async (value) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ResolveResponse>(queryKey);

      // Clearing falls through to a layer only the server knows about, and an
      // enforced value will not move at all. Neither is safe to predict.
      const predictable = value !== undefined && setting !== undefined && !isEnforced(setting);
      if (predictable) {
        queryClient.setQueryData<ResolveResponse>(queryKey, (current) =>
          current ? withValue(current, name, value, sourceForLayer(layer)) : current,
        );
      }

      return { previous };
    },

    onError: (writeError, _value, context) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
      options.onError?.(writeError);
    },

    onSuccess: (_data, value) => {
      if (setting) options.onWritten?.(value, setting);
    },

    // The server canonicalises what it stores — a DATETIME comes back in UTC —
    // so the truth always comes from the next resolution.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const write = useCallback(
    async (value: SettingValue | undefined) => {
      if (!setting) return false;

      if (shouldValidate && value !== undefined) {
        const found = validateValue(setting, value);
        setProblem(found);
        if (found) {
          options.onError?.(new Error(`${setting.name}: ${found.message}`));
          return false;
        }
      } else {
        setProblem(null);
      }

      try {
        await mutation.mutateAsync(value);
        return true;
      } catch {
        // The failure is in `writeError`; a control should not have to catch.
        return false;
      }
    },
    [setting, shouldValidate, mutation, options],
  );

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey });
  }, [queryClient, queryKey]);

  return {
    setting,
    value: setting?.value ?? null,
    status: setting ? settingStatus(setting) : undefined,
    isLoading,
    error: error ?? null,
    isWriting: mutation.isPending,
    writeError: mutation.error,
    problem,
    canWrite: writable && setting !== undefined && !isEnforced(setting),
    set: (value: SettingValue) => write(value),
    clear: () => write(undefined),
    refresh,
  };
}

/**
 * One value, typed by the caller, for a feature check rather than a control.
 *
 * @example
 * const betaEnabled = useSettingValue<boolean>("beta.enabled", false);
 */
export function useSettingValue<T = SettingValue>(
  name: string,
  fallback: T,
  options: UseSettingsOptions = {},
): T {
  const { snapshot } = useSettings(options);
  const setting = snapshot?.get(name);
  if (!setting || setting.source === "UNSET" || setting.value === null) return fallback;
  return setting.value as T;
}
