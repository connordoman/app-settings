import * as React from "react";

export function Card(props: React.ComponentProps<"div">) {
  return <div data-slot="card" {...props} />;
}
export function CardHeader(props: React.ComponentProps<"div">) {
  return <div data-slot="card-header" {...props} />;
}
export function CardTitle(props: React.ComponentProps<"div">) {
  return <div data-slot="card-title" {...props} />;
}
export function CardDescription(props: React.ComponentProps<"div">) {
  return <div data-slot="card-description" {...props} />;
}
export function CardContent(props: React.ComponentProps<"div">) {
  return <div data-slot="card-content" {...props} />;
}
export function CardAction(props: React.ComponentProps<"div">) {
  return <div data-slot="card-action" {...props} />;
}
