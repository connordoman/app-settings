import * as React from "react";

export interface SeparatorProps extends React.ComponentProps<"div"> {
  orientation?: "horizontal" | "vertical";
  decorative?: boolean;
}

export function Separator({ orientation, decorative, ...props }: SeparatorProps) {
  return <div data-slot="separator" {...props} />;
}
