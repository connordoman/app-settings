import * as React from "react";

export function Empty(props: React.ComponentProps<"div">) {
  return <div data-slot="empty" {...props} />;
}
export function EmptyHeader(props: React.ComponentProps<"div">) {
  return <div data-slot="empty-header" {...props} />;
}
export function EmptyMedia({
  variant,
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "icon" }) {
  return <div data-slot="empty-icon" data-variant={variant} {...props} />;
}
export function EmptyTitle(props: React.ComponentProps<"div">) {
  return <div data-slot="empty-title" {...props} />;
}
export function EmptyDescription(props: React.ComponentProps<"p">) {
  return <p data-slot="empty-description" {...props} />;
}
export function EmptyContent(props: React.ComponentProps<"div">) {
  return <div data-slot="empty-content" {...props} />;
}
