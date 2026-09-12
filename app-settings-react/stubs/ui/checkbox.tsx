import * as React from "react";

export interface CheckboxProps extends Omit<React.ComponentProps<"button">, "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function Checkbox({ checked, onCheckedChange, ...props }: CheckboxProps) {
  return <button role="checkbox" data-slot="checkbox" aria-checked={checked} {...props} />;
}
