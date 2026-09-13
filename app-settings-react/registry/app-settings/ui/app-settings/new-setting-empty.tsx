"use client";

import * as React from "react";
import { cva } from "class-variance-authority";
import { LockIcon, PlusIcon, ServerIcon, UserIcon, UsersIcon, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import {
  useCreateSettingPermission,
  type CreateSettingPermission,
  type UseCreateSettingPermissionOptions,
} from "@/registry/app-settings/hooks/app-settings/use-api-key";
import { SETTING_LAYERS } from "@/registry/app-settings/lib/app-settings/permissions";
import type { SettingLayer } from "@/registry/app-settings/lib/app-settings/types";

/**
 * A layer's colours, matching `SettingSourceBadge` so a personal setting reads
 * the same whether it is being created or displayed.
 */
export const newSettingEmptyVariants = cva("border border-dashed transition-opacity", {
  variants: {
    variant: {
      personal: "[&_[data-slot=empty-icon]]:bg-sky-500/10 [&_[data-slot=empty-icon]]:text-sky-700 dark:[&_[data-slot=empty-icon]]:text-sky-400",
      group: "[&_[data-slot=empty-icon]]:bg-amber-500/10 [&_[data-slot=empty-icon]]:text-amber-700 dark:[&_[data-slot=empty-icon]]:text-amber-400",
      server: "[&_[data-slot=empty-icon]]:bg-secondary [&_[data-slot=empty-icon]]:text-secondary-foreground",
    },
    disabled: {
      true: "bg-muted/30 opacity-60",
      false: "",
    },
  },
  defaultVariants: { variant: "server", disabled: false },
});

interface LayerCopy {
  icon: LucideIcon;
  title: string;
  description: string;
  action: string;
}

/** The default wording for each layer. Every piece is overridable by prop. */
export const newSettingCopy: Record<SettingLayer, LayerCopy> = {
  personal: {
    icon: UserIcon,
    title: "Personal setting",
    description: "A preference each user sets for themselves.",
    action: "New personal setting",
  },
  group: {
    icon: UsersIcon,
    title: "Group setting",
    description: "A policy applied to everyone in a group, optionally enforced.",
    action: "New group setting",
  },
  server: {
    icon: ServerIcon,
    title: "Server setting",
    description: "One value for the whole deployment.",
    action: "New server setting",
  },
};

export interface NewSettingEmptyProps
  extends Omit<React.ComponentProps<"div">, "title" | "children">,
    UseCreateSettingPermissionOptions {
  /** Which layer the new setting is created in. */
  variant: SettingLayer;
  /** Called when the action is pressed. Open your create dialog here. */
  onCreate?: (variant: SettingLayer) => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** The button's label. */
  actionLabel?: React.ReactNode;
  icon?: React.ReactNode;
  /** Disables the variant whatever the key allows. */
  disabled?: boolean;
  /** Explains why the variant is disabled. Defaults to the missing scopes. */
  disabledReason?: React.ReactNode | ((permission: CreateSettingPermission) => React.ReactNode);
  /** Replaces the button, with the permission handed to you. */
  children?: (state: { permission: CreateSettingPermission; disabled: boolean }) => React.ReactNode;
}

/**
 * An empty state offering to create a setting in one layer.
 *
 * It asks the provider's transport what the API key may do, and renders
 * visibly disabled — dimmed, locked, with the reason — when the key cannot
 * create a setting of this kind.
 *
 * @example
 * <NewSettingEmpty variant="group" onCreate={() => setDialog("group")} />
 */
export function NewSettingEmpty({
  variant,
  onCreate,
  title,
  description,
  actionLabel,
  icon,
  disabled: forceDisabled = false,
  disabledReason,
  scopes,
  requirements,
  className,
  children,
  ...props
}: NewSettingEmptyProps) {
  const permission = useCreateSettingPermission(variant, { scopes, requirements });
  const disabled = forceDisabled || !permission.allowed;
  const copy = newSettingCopy[variant];
  const Icon = copy.icon;
  const reasonId = React.useId();

  const reason = disabled
    ? typeof disabledReason === "function"
      ? disabledReason(permission)
      : (disabledReason ?? defaultReason(permission))
    : null;

  return (
    <Empty
      data-slot="new-setting-empty"
      data-variant={variant}
      data-disabled={disabled || undefined}
      data-pending={permission.pending || undefined}
      aria-disabled={disabled || undefined}
      className={cn(newSettingEmptyVariants({ variant, disabled }), className)}
      {...props}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon ?? <Icon aria-hidden />}</EmptyMedia>
        <EmptyTitle>{title ?? copy.title}</EmptyTitle>
        <EmptyDescription>{description ?? copy.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {children ? (
          children({ permission, disabled })
        ) : (
          <Button
            variant={disabled ? "outline" : "default"}
            disabled={disabled}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => onCreate?.(variant)}
          >
            {disabled && !permission.pending ? <LockIcon aria-hidden /> : <PlusIcon aria-hidden />}
            {actionLabel ?? copy.action}
          </Button>
        )}
        {reason && (
          <p id={reasonId} data-slot="new-setting-empty-reason" className="text-muted-foreground text-xs">
            {reason}
          </p>
        )}
      </EmptyContent>
    </Empty>
  );
}

function defaultReason(permission: CreateSettingPermission): React.ReactNode {
  if (permission.pending) return "Checking this key's permissions…";
  if (permission.missing.length === 0) return "This board is read-only.";
  return (
    <>
      This API key needs{" "}
      {permission.missing.map((scope, index) => (
        <React.Fragment key={scope}>
          {index > 0 && ", "}
          <code className="font-mono">{scope}</code>
        </React.Fragment>
      ))}
      .
    </>
  );
}

export interface NewSettingChooserProps
  extends Omit<React.ComponentProps<"div">, "children">,
    UseCreateSettingPermissionOptions {
  /** Which variants to offer, in order. Defaults to personal, group, server. */
  variants?: readonly SettingLayer[];
  onCreate?: (variant: SettingLayer) => void;
  /** Forwarded to every variant, or per variant by key. */
  itemProps?: Partial<Record<SettingLayer, Partial<NewSettingEmptyProps>>>;
}

/**
 * Every variant side by side, for a page with no settings yet.
 *
 * @example
 * <NewSettingChooser onCreate={(layer) => openCreateDialog(layer)} />
 */
export function NewSettingChooser({
  variants = SETTING_LAYERS,
  onCreate,
  scopes,
  requirements,
  itemProps,
  className,
  ...props
}: NewSettingChooserProps) {
  return (
    <div
      data-slot="new-setting-chooser"
      className={cn("grid gap-4 md:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]", className)}
      {...props}
    >
      {variants.map((variant) => (
        <NewSettingEmpty
          key={variant}
          variant={variant}
          onCreate={onCreate}
          scopes={scopes}
          requirements={requirements}
          {...itemProps?.[variant]}
        />
      ))}
    </div>
  );
}
