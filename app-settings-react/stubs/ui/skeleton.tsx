import * as React from "react";

export function Skeleton(props: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" {...props} />;
}
