"use client";

/**
 * Editing many settings and saving them together.
 *
 * {@link useSetting} writes on every change, which is right for a switchboard.
 * A form with a Save button wants the opposite: hold the edits locally, show
 * what is dirty, then apply them in one go. That is this hook.
 */

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAppSettingsConfig } from "@/registry/app-settings/lib/app-settings/context";
import {
  controlValue,
  isEnforced,
  validateValue,
  valuesEqual,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  ResolvedSetting,
  SettingValue,
  ValueProblem,
  WriteRequest,
} from "@/registry/app-settings/lib/app-settings/types";
import {
  useSettings,
  type UseSettingsOptions,
} from "@/registry/app-settings/hooks/app-settings/use-settings";
import type { WriteOptions } from "@/registry/app-settings/hooks/app-settings/use-setting";

export interface UseSettingsDraftOptions extends UseSettingsOptions, WriteOptions {
  /** Only these settings, in this order. Defaults to everything resolved. */
  names?: string[];
  /** Called once every write has been attempted, successful or not. */
  onSaved?: (result: SaveResult) => void;
}

/** What a save actually managed to do. */
export interface SaveResult {
  /** Names written, in the order they were attempted. */
  written: string[];
  /** Names that failed, with the reason each one did. */
  failed: { name: string; error: Error }[];
}

/** Everything a controlled field needs, so a form can spread it. */
export interface DraftField {
  setting: ResolvedSetting;
  value: SettingValue;
  onValueChange: (value: SettingValue) => void;
  /** Edited locally and not yet saved. */
  dirty: boolean;
  /** Why this edit is not savable. */
  problem: ValueProblem | null;
  disabled: boolean;
}

export interface UseSettingsDraftResult {
  /** The settings in scope, in the server's order or the order given. */
  settings: ResolvedSetting[];
  /** Effective values with local edits laid over them, by setting name. */
  values: Record<string, SettingValue>;
  /** Only the local edits. */
  draft: Record<string, SettingValue>;
  /** Names whose draft value differs from the resolved one. */
  dirty: string[];
  isDirty: boolean;
  /** Local validation failures, by setting name. */
  problems: Record<string, ValueProblem>;
  /** At least one edit would be rejected, so saving is blocked. */
  hasProblems: boolean;
  isLoading: boolean;
  error: Error | null;
  isSaving: boolean;
  /** The last save that had failures, for a summary above the form. */
  lastResult: SaveResult | null;
  /** Records an edit. Validates it immediately but writes nothing. */
  setValue: (name: string, value: SettingValue) => void;
  /** Drops one edit, or every edit when called with no name. */
  revert: (name?: string) => void;
  /** Writes every dirty value. Never rejects: read the result. */
  save: () => Promise<SaveResult>;
  /** Everything one field needs, ready to spread onto `<SettingField>`. */
  field: (name: string) => DraftField | undefined;
}

/**
 * A local draft over a resolution.
 *
 * @example
 * const draft = useSettingsDraft({ names: ["rate.limit", "signups.enabled"] });
 *
 * <SettingField {...draft.field("rate.limit")!} />
 * <Button disabled={!draft.isDirty || draft.hasProblems} onClick={draft.save}>
 *   Save {draft.dirty.length} changes
 * </Button>
 */
export function useSettingsDraft(
  options: UseSettingsDraftOptions = {},
): UseSettingsDraftResult {
  const config = useAppSettingsConfig();
  const queryClient = useQueryClient();
  const { snapshot, queryKey, isLoading, error } = useSettings(options);

  const [draft, setDraft] = useState<Record<string, SettingValue>>({});
  const [problems, setProblems] = useState<Record<string, ValueProblem>>({});
  const [lastResult, setLastResult] = useState<SaveResult | null>(null);

  const layer = options.layer ?? config.layer;
  const shouldValidate = options.validate ?? config.validate;
  const writable = config.transport.write !== undefined && !config.readOnly;

  const settings = useMemo(() => {
    if (!snapshot) return [];
    if (!options.names) return [...snapshot.settings];
    return options.names
      .map((name) => snapshot.get(name))
      .filter((setting): setting is ResolvedSetting => setting !== undefined);
  }, [snapshot, options.names]);

  const values = useMemo(() => {
    const merged: Record<string, SettingValue> = {};
    for (const setting of settings) {
      merged[setting.name] =
        setting.name in draft ? draft[setting.name] : controlValue(setting);
    }
    return merged;
  }, [settings, draft]);

  const dirty = useMemo(
    () =>
      settings
        .filter(
          (setting) =>
            setting.name in draft && !valuesEqual(draft[setting.name], setting.value),
        )
        .map((setting) => setting.name),
    [settings, draft],
  );

  const setValue = useCallback(
    (name: string, value: SettingValue) => {
      setDraft((current) => ({ ...current, [name]: value }));

      if (!shouldValidate) return;
      const setting = snapshot?.get(name);
      const found = setting ? validateValue(setting, value) : null;

      setProblems((current) => {
        if (!found) {
          if (!(name in current)) return current;
          const { [name]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [name]: found };
      });
    },
    [shouldValidate, snapshot],
  );

  const revert = useCallback((name?: string) => {
    if (name === undefined) {
      setDraft({});
      setProblems({});
      return;
    }
    setDraft(({ [name]: _dropped, ...rest }) => rest);
    setProblems(({ [name]: _cleared, ...rest }) => rest);
  }, []);

  const mutation = useMutation<SaveResult, Error, void>({
    mutationFn: async () => {
      const write = config.transport.write;
      if (!write) throw new Error("this transport is read-only: it has no write()");

      const result: SaveResult = { written: [], failed: [] };

      // Sequential on purpose: a failure halfway through leaves a state a
      // reader can reason about, and the API is not a bulk endpoint.
      for (const name of dirty) {
        const setting = snapshot?.get(name);
        if (!setting) continue;

        const request: WriteRequest = {
          setting,
          value: draft[name],
          layer,
          userId:
            layer === "personal"
              ? (options.writeUserId ?? options.userId ?? config.query.userId)
              : undefined,
          groupId: layer === "group" ? (options.writeGroupId ?? config.writeGroupId) : undefined,
          visible: options.visible ?? config.visible,
          enforced: options.enforced ?? config.enforced,
        };

        try {
          await write(request);
          result.written.push(name);
        } catch (caught) {
          result.failed.push({
            name,
            error: caught instanceof Error ? caught : new Error(String(caught)),
          });
        }
      }

      return result;
    },

    onSuccess: (result) => {
      setLastResult(result);
      // Keep the edits that failed, so the form still shows what to retry.
      setDraft((current) => {
        const remaining = { ...current };
        for (const name of result.written) delete remaining[name];
        return remaining;
      });
      options.onSaved?.(result);
    },

    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  const save = useCallback(async () => {
    if (Object.keys(problems).length > 0) {
      const result: SaveResult = {
        written: [],
        failed: Object.entries(problems).map(([name, problem]) => ({
          name,
          error: new Error(`${name}: ${problem.message}`),
        })),
      };
      setLastResult(result);
      return result;
    }

    try {
      return await mutation.mutateAsync();
    } catch (caught) {
      const result: SaveResult = {
        written: [],
        failed: dirty.map((name) => ({
          name,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        })),
      };
      setLastResult(result);
      return result;
    }
  }, [problems, mutation, dirty]);

  const field = useCallback(
    (name: string): DraftField | undefined => {
      const setting = settings.find((candidate) => candidate.name === name);
      if (!setting) return undefined;

      return {
        setting,
        value: values[name] ?? controlValue(setting),
        onValueChange: (value: SettingValue) => setValue(name, value),
        dirty: dirty.includes(name),
        problem: problems[name] ?? null,
        disabled: !writable || isEnforced(setting),
      };
    },
    [settings, values, dirty, problems, writable, setValue],
  );

  return {
    settings,
    values,
    draft,
    dirty,
    isDirty: dirty.length > 0,
    problems,
    hasProblems: Object.keys(problems).length > 0,
    isLoading,
    error: error ?? null,
    isSaving: mutation.isPending,
    lastResult,
    setValue,
    revert,
    save,
    field,
  };
}
