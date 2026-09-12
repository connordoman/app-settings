# Type-check stubs

Nothing here is published or installed into a consumer's project.

The registry source imports shadcn primitives from `@/components/ui/*` and `cn`
from `@/lib/utils`, because those are the paths the shadcn CLI rewrites to the
consumer's own aliases at install time. This package has no shadcn project of
its own, so these stubs stand in for those modules when `just typecheck` runs.

They mirror only the prop surface the registry actually uses. If a component
here needs a prop the real shadcn primitive does not have, that is a bug in the
registry, not something to add to the stub.
