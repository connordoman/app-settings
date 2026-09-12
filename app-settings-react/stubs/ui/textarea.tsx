import * as React from "react";

export function Textarea(props: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" {...props} />;
}
