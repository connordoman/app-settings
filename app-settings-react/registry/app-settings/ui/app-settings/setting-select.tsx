"use client";

import * as React from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  asArray,
  isMultiSelect,
  optionToken,
  selectOptions,
} from "@/registry/app-settings/lib/app-settings/values";
import type {
  SettingInputProps,
  SettingValue,
} from "@/registry/app-settings/lib/app-settings/types";

export interface SettingSelectProps extends SettingInputProps<SettingValue> {
  placeholder?: string;
  /** Forwarded to the trigger, for width or a `data-*` attribute. */
  triggerProps?: React.ComponentProps<typeof SelectTrigger>;
}

/**
 * The control for a `SELECT` setting.
 *
 * A single-choice setting gets a select; a `multiple` one gets a checkbox
 * list, because a multi-select popover hides what is chosen behind a click and
 * a settings board exists to show exactly that.
 *
 * Option values need not be strings — the server allows numbers and booleans —
 * so each option carries a string token for the DOM and the real value is
 * recovered from it on change.
 */
export function SettingSelect({
  setting,
  value,
  onValueChange,
  disabled,
  pending,
  id,
  className,
  placeholder = "Choose…",
  triggerProps,
  ...props
}: SettingSelectProps) {
  const options = selectOptions(setting);

  if (isMultiSelect(setting)) {
    const chosen = new Set(asArray(value).map(optionToken));

    return (
      <div
        data-slot="setting-select"
        data-multiple
        data-pending={pending || undefined}
        role="group"
        aria-labelledby={id}
        className={cn("flex flex-col gap-2", className)}
        {...props}
      >
        {options.map((option) => {
          const optionId = `${id ?? setting.name}-${option.token}`;
          return (
            <div key={option.token} className="flex items-center gap-2">
              <Checkbox
                id={optionId}
                checked={chosen.has(option.token)}
                disabled={disabled}
                onCheckedChange={(checked) => {
                  const next = options
                    .filter((candidate) =>
                      candidate.token === option.token
                        ? checked === true
                        : chosen.has(candidate.token),
                    )
                    .map((candidate) => candidate.value);
                  onValueChange(next);
                }}
              />
              <Label htmlFor={optionId} className="text-sm font-normal">
                {option.label}
              </Label>
            </div>
          );
        })}
      </div>
    );
  }

  const current = value === null || value === undefined ? undefined : optionToken(value);

  return (
    <Select
      value={current}
      disabled={disabled}
      onValueChange={(token) => {
        const option = options.find((candidate) => candidate.token === token);
        if (option) onValueChange(option.value);
      }}
    >
      <SelectTrigger
        data-slot="setting-select"
        data-pending={pending || undefined}
        id={id}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        className={cn("max-w-[16rem]", className)}
        {...triggerProps}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.token} value={option.token}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
