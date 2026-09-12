"use client";

import * as React from "react";
import { RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ValueSource } from "@/registry/app-settings/lib/app-settings/types";

export interface SettingResetButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "onClick"> {
  /** Clears this layer's value. Usually `useSetting(...).clear`. */
  onReset: () => void | Promise<unknown>;
  /** The layer the value currently comes from, used to decide whether to show. */
  source?: ValueSource;
  /** Renders even when the value is already inherited. */
  alwaysVisible?: boolean;
  /** Replaces the icon-only button with your own content. */
  children?: React.ReactNode;
}

/**
 * Clears a stored value so the setting falls back to the layer beneath it.
 *
 * By default it renders nothing when there is nothing to clear — a value that
 * is already the default or unset — because a button that cannot do anything is
 * noise on a page with fifty rows.
 */
export function SettingResetButton({
  onReset,
  source,
  alwaysVisible = false,
  className,
  variant = "ghost",
  size,
  children,
  ...props
}: SettingResetButtonProps) {
  const stored = source === undefined || (source !== "DEFAULT" && source !== "UNSET");
  if (!stored && !alwaysVisible) return null;

  return (
    <Button
      data-slot="setting-reset-button"
      type="button"
      variant={variant}
      size={size ?? (children ? "sm" : "icon")}
      aria-label={children ? undefined : "Reset to inherited value"}
      title="Reset to inherited value"
      className={cn("text-muted-foreground hover:text-foreground", className)}
      onClick={() => void onReset()}
      {...props}
    >
      {children ?? <RotateCcwIcon className="size-3.5" aria-hidden />}
    </Button>
  );
}
