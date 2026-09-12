"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  numberStep,
  parseNumberInput,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  SettingInputComponentProps,
} from "@/registry/app-settings/lib/app-settings/types";
import { useSettingText } from "@/registry/app-settings/hooks/app-settings/use-setting-text";

export type SettingNumberInputProps = SettingInputComponentProps<
  number,
  React.ComponentProps<typeof Input>
> & {
  /** `blur` — the default — avoids a write per keystroke. */
  commitOn?: "blur" | "change";
};

/**
 * The control for a `NUMBER` setting.
 *
 * `min`, `max` and `step` come from the setting's own `type_config`, so the
 * browser's spinner respects the same bounds the server enforces.
 */
export function SettingNumberInput({
  setting,
  value,
  onValueChange,
  disabled,
  pending,
  commitOn = "blur",
  className,
  ...props
}: SettingNumberInputProps) {
  const config = setting.type_config ?? {};

  const text = useSettingText<number>({
    value,
    format: (current) => (Number.isFinite(current) ? String(current) : ""),
    parse: (raw) => {
      const parsed = parseNumberInput(raw);
      return parsed === undefined
        ? { ok: false, problem: { rule: "type", message: "Must be a number." } }
        : { ok: true, value: parsed };
    },
    onValueChange,
    commitOn,
  });

  return (
    <Input
      data-slot="setting-number-input"
      data-pending={pending || undefined}
      type="number"
      inputMode={config.integer ? "numeric" : "decimal"}
      min={config.min}
      max={config.max}
      step={numberStep(config)}
      value={text.text}
      onChange={text.onChange}
      onFocus={text.onFocus}
      onBlur={text.onBlur}
      onKeyDown={text.onKeyDown}
      disabled={disabled}
      aria-invalid={props["aria-invalid"] || text.problem !== null || undefined}
      className={cn("max-w-[12rem] font-mono tabular-nums", className)}
      {...props}
    />
  );
}
