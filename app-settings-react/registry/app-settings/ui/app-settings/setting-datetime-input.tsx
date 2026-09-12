"use client";

import * as React from "react";
import { localToInstant } from "app-settings-js";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatDateTimeInput } from "@/registry/app-settings/lib/app-settings/values";
import type {
  SettingInputComponentProps,
} from "@/registry/app-settings/lib/app-settings/types";
import { useSettingText } from "@/registry/app-settings/hooks/app-settings/use-setting-text";

export type SettingDateTimeInputProps = SettingInputComponentProps<
  string,
  React.ComponentProps<typeof Input>
> & {
  /**
   * The zone the reading is interpreted in. Defaults to the browser's own.
   *
   * The same wall-clock reading is a different instant in every zone, so an
   * operator setting a cutoff for a specific region should say which one.
   */
  timeZone?: string;
  commitOn?: "blur" | "change";
};

/**
 * The control for a `DATETIME` setting.
 *
 * The server stores instants and rejects a bare reading, so what the input
 * shows is the value in a timezone and what it commits is the RFC 3339 instant
 * that reading corresponds to.
 */
export function SettingDateTimeInput({
  setting,
  value,
  onValueChange,
  disabled,
  pending,
  timeZone,
  commitOn = "blur",
  className,
  ...props
}: SettingDateTimeInputProps) {
  const text = useSettingText<string>({
    value,
    format: (current) => formatDateTimeInput(current, timeZone),
    parse: (raw) => {
      if (raw.trim() === "") return { ok: true, value: "" };
      try {
        return { ok: true, value: localToInstant(raw, timeZone) };
      } catch (caught) {
        return {
          ok: false,
          problem: {
            rule: "type",
            message: caught instanceof Error ? caught.message : "Not a date and time.",
          },
        };
      }
    },
    onValueChange,
    commitOn,
  });

  return (
    <Input
      data-slot="setting-datetime-input"
      data-pending={pending || undefined}
      type="datetime-local"
      step={1}
      value={text.text}
      onChange={text.onChange}
      onFocus={text.onFocus}
      onBlur={text.onBlur}
      onKeyDown={text.onKeyDown}
      disabled={disabled}
      aria-invalid={props["aria-invalid"] || text.problem !== null || undefined}
      className={cn("max-w-[16rem]", className)}
      {...props}
    />
  );
}
