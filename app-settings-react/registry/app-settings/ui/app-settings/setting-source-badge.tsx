"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { LockIcon, UsersIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  describeOverride,
  sourceLabel,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  Override,
  ValueSource,
} from "@/registry/app-settings/lib/app-settings/types";

/**
 * Which layer a value came from, as a badge.
 *
 * The colours are tokens, not hexes, so a theme swap carries them. Restyle a
 * single layer by passing `className` — it is merged last and wins.
 */
export const settingSourceBadgeVariants = cva("font-mono text-[0.7rem] font-normal", {
  variants: {
    source: {
      UNSET: "text-muted-foreground border-dashed",
      DEFAULT: "text-muted-foreground",
      SERVER: "border-transparent bg-secondary text-secondary-foreground",
      INTERMEDIATE: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      PERSONAL: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
    },
  },
  defaultVariants: { source: "DEFAULT" },
});

export interface SettingSourceBadgeProps
  extends Omit<React.ComponentProps<typeof Badge>, "variant">,
    Omit<VariantProps<typeof settingSourceBadgeVariants>, "source"> {
  source: ValueSource;
  /** Overrides the layer's own label, e.g. "Inherited" rather than "Default". */
  label?: string;
}

export function SettingSourceBadge({
  source,
  label,
  className,
  ...props
}: SettingSourceBadgeProps) {
  return (
    <Badge
      data-slot="setting-source-badge"
      data-source={source}
      variant="outline"
      className={cn(settingSourceBadgeVariants({ source }), className)}
      {...props}
    >
      {label ?? sourceLabel(source)}
    </Badge>
  );
}

export interface SettingOverrideBadgeProps extends Omit<React.ComponentProps<typeof Badge>, "variant"> {
  override: Override;
  /** Hides the group id, for a board where every row shares one group. */
  hideGroup?: boolean;
}

/**
 * A group override, as a badge.
 *
 * An enforced override is the one a reader must not miss: it means the control
 * beneath it cannot change anything.
 */
export function SettingOverrideBadge({
  override,
  hideGroup = false,
  className,
  children,
  ...props
}: SettingOverrideBadgeProps) {
  const enforced = override.enforced;
  const Icon = enforced ? LockIcon : UsersIcon;

  return (
    <Badge
      data-slot="setting-override-badge"
      data-enforced={enforced || undefined}
      variant="outline"
      title={describeOverride(override)}
      className={cn(
        "gap-1 text-[0.7rem] font-normal",
        enforced
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
        className,
      )}
      {...props}
    >
      <Icon className="size-3" aria-hidden />
      {children ?? (
        <>
          {enforced ? "Enforced" : "Override"}
          {!hideGroup && <span className="font-mono opacity-70">{override.group_id}</span>}
        </>
      )}
    </Badge>
  );
}
