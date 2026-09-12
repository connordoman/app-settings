"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  SettingInputComponentProps,
} from "@/registry/app-settings/lib/app-settings/types";
import { useSettingText } from "@/registry/app-settings/hooks/app-settings/use-setting-text";

export type SettingTextInputProps = SettingInputComponentProps<
  string,
  React.ComponentProps<typeof Input>
> & {
  /**
   * Render a textarea instead of a single-line input.
   *
   * Left unset, a setting whose `max_length` is over 120 gets one, since that
   * is rarely a value anyone wants to edit through a one-line field.
   */
  multiline?: boolean;
  rows?: number;
  commitOn?: "blur" | "change";
};

/** The control for a `STRING` setting. */
export function SettingTextInput({
  setting,
  value,
  onValueChange,
  disabled,
  pending,
  multiline,
  rows = 3,
  commitOn = "blur",
  className,
  ...props
}: SettingTextInputProps) {
  const config = setting.type_config ?? {};
  const long = multiline ?? (config.max_length !== undefined && config.max_length > 120);

  const text = useSettingText<string>({
    value,
    format: (current) => current ?? "",
    parse: (raw) => ({ ok: true, value: raw }),
    onValueChange,
    commitOn,
    commitOnEnter: !long,
  });

  const shared = {
    "data-pending": pending || undefined,
    value: text.text,
    onChange: text.onChange,
    onFocus: text.onFocus,
    onBlur: text.onBlur,
    onKeyDown: text.onKeyDown,
    disabled,
    maxLength: config.max_length,
    minLength: config.min_length,
  } as const;

  if (long) {
    return (
      <Textarea
        data-slot="setting-text-input"
        rows={rows}
        {...shared}
        className={cn("min-h-16", className)}
        {...(props as React.ComponentProps<typeof Textarea>)}
      />
    );
  }

  return (
    <Input
      data-slot="setting-text-input"
      type="text"
      // A pattern is RE2 on the server; the browser reads it as a JavaScript
      // regex, which is close enough for a hint and never the last word.
      pattern={config.pattern}
      {...shared}
      className={className}
      {...props}
    />
  );
}
