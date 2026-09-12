"use client";

import * as React from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  formatJsonInput,
  parseJsonInput,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  SettingInputComponentProps,
  SettingValue,
} from "@/registry/app-settings/lib/app-settings/types";
import { useSettingText } from "@/registry/app-settings/hooks/app-settings/use-setting-text";

export type SettingJsonInputProps = SettingInputComponentProps<
  SettingValue,
  React.ComponentProps<typeof Textarea>
> & {
  rows?: number;
  commitOn?: "blur" | "change";
};

/**
 * The control for a `JSON` setting.
 *
 * The parser's own complaint is shown under the field, and nothing is committed
 * while the text is not JSON — so a half-typed object cannot be saved.
 */
export function SettingJsonInput({
  setting,
  value,
  onValueChange,
  disabled,
  pending,
  rows = 6,
  commitOn = "blur",
  className,
  ...props
}: SettingJsonInputProps) {
  const text = useSettingText<SettingValue>({
    value,
    format: formatJsonInput,
    parse: (raw) => {
      const parsed = parseJsonInput(raw);
      return parsed.ok
        ? { ok: true, value: parsed.value }
        : { ok: false, problem: parsed.problem };
    },
    onValueChange,
    commitOn,
    commitOnEnter: false,
  });

  return (
    <div className="flex w-full flex-col gap-1.5">
      <Textarea
        data-slot="setting-json-input"
        data-pending={pending || undefined}
        spellCheck={false}
        rows={rows}
        value={text.text}
        onChange={text.onChange}
        onFocus={text.onFocus}
        onBlur={text.onBlur}
        onKeyDown={text.onKeyDown}
        disabled={disabled}
        aria-invalid={props["aria-invalid"] || text.problem !== null || undefined}
        className={cn("font-mono text-xs", className)}
        {...props}
      />
      {text.problem && (
        <p className="text-destructive text-xs" role="alert">
          {text.problem.message}
        </p>
      )}
    </div>
  );
}
