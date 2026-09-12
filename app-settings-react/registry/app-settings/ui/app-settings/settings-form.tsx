"use client";

import * as React from "react";
import { LoaderCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  groupSettings,
  type GroupBy,
} from "@/registry/app-settings/lib/app-settings/grouping";
import type { ResolvedSetting } from "@/registry/app-settings/lib/app-settings/types";
import {
  useSettingsDraft,
  type SaveResult,
  type UseSettingsDraftOptions,
  type UseSettingsDraftResult,
} from "@/registry/app-settings/hooks/app-settings/use-settings-draft";
import {
  SettingField,
  SettingFieldSkeleton,
  type SettingFieldProps,
} from "@/registry/app-settings/ui/app-settings/setting-field";
import { SettingListSection } from "@/registry/app-settings/ui/app-settings/setting-list";

export interface SettingsFormProps
  extends Omit<React.ComponentProps<"form">, "children" | "onSubmit"> {
  /** Only these settings, in this order. */
  names?: string[];
  filter?: (setting: ResolvedSetting) => boolean;
  groupBy?: GroupBy;
  titles?: Record<string, string>;
  order?: string[];
  card?: boolean;
  /** What to resolve and where writes land. */
  draftOptions?: UseSettingsDraftOptions;
  /** Forwarded to every field. */
  fieldProps?: Partial<SettingFieldProps>;
  /** Called once every write has been attempted. */
  onSaved?: (result: SaveResult) => void;
  /** Replaces the footer. A function receives the draft, for a custom bar. */
  footer?: React.ReactNode | ((draft: UseSettingsDraftResult) => React.ReactNode);
  skeletonRows?: number;
}

/**
 * Many settings edited together and saved in one go.
 *
 * Edits are held locally, so a half-typed value never reaches the server, and
 * the footer says exactly how many rows are pending. Writes are applied one at
 * a time; a row that fails keeps its edit so it can be retried.
 *
 * @example
 * <SettingsForm groupBy="prefix" onSaved={(r) => toast(`Saved ${r.written.length}`)} />
 */
export function SettingsForm({
  names,
  filter,
  groupBy = "none",
  titles,
  order,
  card = true,
  draftOptions,
  fieldProps,
  onSaved,
  footer,
  skeletonRows = 4,
  className,
  ...props
}: SettingsFormProps) {
  const draft = useSettingsDraft({ names, ...draftOptions, onSaved });

  const visible = React.useMemo(
    () => (filter ? draft.settings.filter(filter) : draft.settings),
    [draft.settings, filter],
  );

  const groups = React.useMemo(
    () => groupSettings(visible, { by: groupBy, titles, order }),
    [visible, groupBy, titles, order],
  );

  if (draft.isLoading) {
    return (
      <div className={cn("flex flex-col gap-2", className)}>
        {Array.from({ length: skeletonRows }, (_, index) => (
          <SettingFieldSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (draft.error) {
    return (
      <div
        role="alert"
        className={cn(
          "border-destructive/30 text-destructive rounded-md border px-4 py-3 text-sm",
          className,
        )}
      >
        Could not load settings: {draft.error.message}
      </div>
    );
  }

  return (
    <form
      data-slot="settings-form"
      className={cn("flex flex-col gap-6", className)}
      onSubmit={(event) => {
        event.preventDefault();
        void draft.save();
      }}
      {...props}
    >
      {groups.map((group) => (
        <SettingListSection key={group.key} group={group} card={card && groupBy !== "none"}>
          {group.settings.map((setting, index) => {
            const field = draft.field(setting.name);
            if (!field) return null;

            return (
              <React.Fragment key={setting.id || setting.name}>
                {index > 0 && <Separator />}
                <SettingField
                  setting={field.setting}
                  value={field.value}
                  onValueChange={field.onValueChange}
                  disabled={field.disabled}
                  dirty={field.dirty}
                  problem={field.problem}
                  inputProps={{ commitOn: "change" }}
                  {...fieldProps}
                />
              </React.Fragment>
            );
          })}
        </SettingListSection>
      ))}

      {typeof footer === "function" ? (
        footer(draft)
      ) : footer !== undefined ? (
        footer
      ) : (
        <SettingsFormFooter draft={draft} />
      )}
    </form>
  );
}

/** The default save bar: what is pending, what failed, and the two buttons. */
export function SettingsFormFooter({
  draft,
  className,
  ...props
}: React.ComponentProps<"div"> & { draft: UseSettingsDraftResult }) {
  const failed = draft.lastResult?.failed ?? [];

  return (
    <div
      data-slot="settings-form-footer"
      data-dirty={draft.isDirty || undefined}
      className={cn(
        "bg-background/80 sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t py-3 backdrop-blur",
        className,
      )}
      {...props}
    >
      <div className="text-muted-foreground text-sm">
        {draft.hasProblems ? (
          <span className="text-destructive">
            {Object.keys(draft.problems).length} change
            {Object.keys(draft.problems).length === 1 ? "" : "s"} cannot be saved.
          </span>
        ) : draft.isDirty ? (
          <span>
            {draft.dirty.length} unsaved change{draft.dirty.length === 1 ? "" : "s"}.
          </span>
        ) : failed.length > 0 ? (
          <span className="text-destructive">
            {failed.length} change{failed.length === 1 ? "" : "s"} failed: {failed[0]?.error.message}
          </span>
        ) : (
          <span>All changes saved.</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!draft.isDirty || draft.isSaving}
          onClick={() => draft.revert()}
        >
          Revert
        </Button>
        <Button type="submit" size="sm" disabled={!draft.isDirty || draft.hasProblems || draft.isSaving}>
          {draft.isSaving && <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden />}
          Save changes
        </Button>
      </div>
    </div>
  );
}
