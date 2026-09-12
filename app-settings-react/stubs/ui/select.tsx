import * as React from "react";

export interface SelectProps {
  value?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}

export function Select({ children }: SelectProps) {
  return <div data-slot="select">{children}</div>;
}
export function SelectTrigger(props: React.ComponentProps<"button"> & { size?: "sm" | "default" }) {
  const { size, ...rest } = props;
  return <button data-slot="select-trigger" {...rest} />;
}
export function SelectValue(props: { placeholder?: string; className?: string }) {
  return <span data-slot="select-value" {...props} />;
}
export function SelectContent(props: React.ComponentProps<"div">) {
  return <div data-slot="select-content" {...props} />;
}
export function SelectItem(props: React.ComponentProps<"div"> & { value: string }) {
  return <div data-slot="select-item" {...props} />;
}
