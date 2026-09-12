"use client";

import * as React from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  groupSettings,
  type GroupBy,
  type SettingGroup,
} from "@/registry/app-settings/lib/app-settings/grouping";
import type { ResolvedSetting } from "@/registry/app-settings/lib/app-settings/types";
import {
  useSettings,
  type UseSettingsOptions,
} from "@/registry/app-settings/hooks/app-settings/use-settings";
import {
  SettingField,
  SettingFieldSkeleton,
  type SettingFieldProps,
} from "@/registry/app-settings/ui/app-settings/setting-field";

export interface SettingListProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Only these settings, in this order. Defaults to everything resolved. */
  names?: string[];
  /** Narrows the list further — by platform, by prefix, by anything. */
  filter?: (setting: ResolvedSetting) => boolean;
  /** Free-text filter over name and description, for a search box above the list. */
  search?: string;
  /** How to section the list. `prefix` reads dotted names. */
  groupBy?: GroupBy;
  /** Overrides a section's heading, keyed by its group key. */
  titles?: Record<string, string>;
  /** Orders the sections. Unlisted keys follow, in first-seen order. */
  order?: string[];
  /** Wrap each section in a card. On by default. */
  card?: boolean;
  /** What to resolve, if not the provider's default. */
  settingsOptions?: UseSettingsOptions;
  /** Forwarded to every field, e.g. `{ showName: false, size: "sm" }`. */
  fieldProps?: Partial<SettingFieldProps>;
  /** Renders one row yourself, instead of `<SettingField>`. */
  renderField?: (setting: ResolvedSetting) => React.ReactNode;
  /** Shown when nothing matches. */
  emptyState?: React.ReactNode;
  /** How many placeholder rows to show while the first resolution loads. */
  skeletonRows?: number;
}

/**
 * A whole resolution, rendered as sections of setting rows.
 *
 * Every row writes as it changes, which is what an operator's switchboard
 * wants. For a form with a Save button, use `<SettingsForm>`.
 *
 * @example
 * <SettingList groupBy="prefix" order={["billing", "signups"]} />
 */
export function SettingList({
  names,
  filter,
  search,
  groupBy = "none",
  titles,
  order,
  card = true,
  settingsOptions,
  fieldProps,
  renderField,
  emptyState,
  skeletonRows = 4,
  className,
  ...props
}: SettingListProps) {
  const { settings, isLoading, error } = useSettings(settingsOptions);

  const visible = React.useMemo(
    () => selectSettings(settings, { names, filter, search }),
    [settings, names, filter, search],
  );

  const groups = React.useMemo(
    () => groupSettings(visible, { by: groupBy, titles, order }),
    [visible, groupBy, titles, order],
  );

  if (isLoading) {
    return (
      <div data-slot="setting-list" className={cn("flex flex-col gap-2", className)} {...props}>
        {Array.from({ length: skeletonRows }, (_, index) => (
          <SettingFieldSkeleton key={index} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-slot="setting-list"
        role="alert"
        className={cn(
          "border-destructive/30 text-destructive rounded-md border px-4 py-3 text-sm",
          className,
        )}
        {...props}
      >
        Could not load settings: {error.message}
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <div
        data-slot="setting-list"
        className={cn("text-muted-foreground py-8 text-center text-sm", className)}
        {...props}
      >
        {emptyState ?? "No settings match."}
      </div>
    );
  }

  return (
    <div
      data-slot="setting-list"
      className={cn("flex flex-col gap-6", className)}
      {...props}
    >
      {groups.map((group) => (
        <SettingListSection key={group.key} group={group} card={card && groupBy !== "none"}>
          {group.settings.map((setting, index) => (
            <React.Fragment key={setting.id || setting.name}>
              {index > 0 && <Separator />}
              {renderField ? (
                renderField(setting)
              ) : (
                <SettingField name={setting.name} settingOptions={settingsOptions} {...fieldProps} />
              )}
            </React.Fragment>
          ))}
        </SettingListSection>
      ))}
    </div>
  );
}

/** One section, with or without card chrome. */
export function SettingListSection({
  group,
  card = true,
  description,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  group: Pick<SettingGroup, "key" | "title">;
  card?: boolean;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (!card) {
    return (
      <div
        data-slot="setting-list-section"
        data-group={group.key}
        className={cn("flex flex-col", className)}
        {...props}
      >
        {children}
      </div>
    );
  }

  return (
    <Card data-slot="setting-list-section" data-group={group.key} className={className}>
      <CardHeader>
        <CardTitle className="text-base">{group.title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col" {...props}>
        {children}
      </CardContent>
    </Card>
  );
}

/** The list's own filtering, exported so a page can reuse it for a count. */
export function selectSettings(
  settings: readonly ResolvedSetting[],
  options: {
    names?: string[];
    filter?: (setting: ResolvedSetting) => boolean;
    search?: string;
  } = {},
): ResolvedSetting[] {
  const { names, filter, search } = options;

  let chosen = names
    ? names
        .map((name) => settings.find((setting) => setting.name === name))
        .filter((setting): setting is ResolvedSetting => setting !== undefined)
    : [...settings];

  if (filter) chosen = chosen.filter(filter);

  const needle = search?.trim().toLowerCase();
  if (needle) {
    chosen = chosen.filter(
      (setting) =>
        setting.name.toLowerCase().includes(needle) ||
        (setting.description ?? "").toLowerCase().includes(needle),
    );
  }

  return chosen;
}
