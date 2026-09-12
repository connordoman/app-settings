import * as React from "react";

export interface ButtonProps extends React.ComponentProps<"button"> {
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  size?: "default" | "sm" | "lg" | "icon";
  asChild?: boolean;
}

export function Button({ variant, size, asChild, ...props }: ButtonProps) {
  return <button data-slot="button" {...props} />;
}
