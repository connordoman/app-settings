"use client";

import * as React from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type {
  SettingInputComponentProps,
} from "@/registry/app-settings/lib/app-settings/types";

export type SettingSwitchProps = SettingInputComponentProps<
  boolean,
  React.ComponentProps<typeof Switch>
>;

/** The control for a `BOOLEAN` setting. */
export function SettingSwitch({
  setting,
  value,
  onValueChange,
  disabled,
  pending,
  className,
  ...props
}: SettingSwitchProps) {
  return (
    <Switch
      data-slot="setting-switch"
      data-pending={pending || undefined}
      checked={value === true}
      onCheckedChange={onValueChange}
      disabled={disabled}
      className={cn("data-[pending=true]:opacity-70", className)}
      {...props}
    />
  );
}
