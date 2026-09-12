import * as React from "react";

export interface BadgeProps extends React.ComponentProps<"span"> {
  variant?: "default" | "secondary" | "destructive" | "outline";
  asChild?: boolean;
}

export function Badge({ variant, asChild, ...props }: BadgeProps) {
  return <span data-slot="badge" {...props} />;
}
