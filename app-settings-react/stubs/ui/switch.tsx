import * as React from "react";

export interface SwitchProps extends Omit<React.ComponentProps<"button">, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function Switch({ checked, onCheckedChange, ...props }: SwitchProps) {
  return <button role="switch" data-slot="switch" aria-checked={checked} {...props} />;
}
