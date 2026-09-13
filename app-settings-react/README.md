# app-settings-react

React components and hooks for building [App Settings](../README.md) UIs, specifically
admin switchboards, preference pages, group policy editors.

## Requirements

- [shadcn/ui](https://ui.shadcn.com)
- React 19

> [!NOTE]
> This is a **shadcn registry**, not an npm package. The components are copied
> into your source tree, where you own them: change the markup, restyle them,
> delete the parts you do not use. They are built on your own shadcn primitives
> and install alongside them rather than over them.

```bash
npx shadcn@latest add connordoman/app-settings/app-settings
```

Everything lives under its own `app-settings` directory:

```tsv
components/ui/app-settings/   setting-field, setting-input, setting-list, …
hooks/app-settings/           use-settings, use-setting, use-settings-draft
lib/app-settings/             transport, values, keys, context, grouping
```

Nothing of yours is touched. A missing primitive like `switch`, `select`, or `badge`
is installed from shadcn/ui if needed, and one you already have is used first.

## Install

```sh
# everything: core, inputs, field, list and form
npx shadcn@latest add connordoman/app-settings/app-settings

# or one piece at a time
npx shadcn@latest add connordoman/app-settings/setting-field
npx shadcn@latest add connordoman/app-settings/app-settings-core
```

Pin a version with a ref, the same way you would pin a dependency:

```sh
npx shadcn@latest add connordoman/app-settings/app-settings#v0.1.2
```

Find and inspect items without knowing their names — the repository address
alone is enough, and the Go server and JS SDK sharing the repo make no
difference:

```sh
npx shadcn@latest list connordoman/app-settings                     # every item
npx shadcn@latest search connordoman/app-settings -q field          # filter
npx shadcn@latest view connordoman/app-settings/setting-field       # one payload
npx shadcn@latest registry validate connordoman/app-settings        # check the manifest
npx shadcn@latest add connordoman/app-settings/setting-field --dry-run
```

<details>
<summary>Installing by namespace instead</summary>

If you would rather type `@app-settings/setting-field`, register the namespace
once. It resolves against the built JSON in [`r/`](./r):

```sh
npx shadcn@latest registry add @app-settings=https://raw.githubusercontent.com/connordoman/app-settings/main/app-settings-react/r/{name}.json
npx shadcn@latest add @app-settings/setting-field
```

Or add it to `components.json` by hand:

```json
{
  "registries": {
    "@app-settings": "https://raw.githubusercontent.com/connordoman/app-settings/main/app-settings-react/r/{name}.json"
  }
}
```

</details>

### Items

| Item                | What it is                                                                         |
| ------------------- | ---------------------------------------------------------------------------------- |
| `app-settings`      | Everything below. Start here.                                                      |
| `app-settings-core` | Transport, hooks, provider. No UI — install this alone to build your own.          |
| `setting-inputs`    | One control per type: `BOOLEAN`, `NUMBER`, `STRING`, `DATETIME`, `SELECT`, `JSON`. |
| `setting-field`     | A labelled row: name, description, control, source badge, override badge, reset.   |
| `setting-list`      | A whole resolution as sections of rows, each writing as it changes.                |
| `settings-form`     | The same rows held as a draft and saved together.                                  |

Requires React 19, Tailwind v4, a shadcn project (`components.json`),
[`@tanstack/react-query`](https://tanstack.com/query) v5 and
[`app-settings-js`](../app-settings-js). The CLI installs the last two for you.

## Two ways to connect

### 1. Straight to App Settings, with an API key

The internal admin case. Resolve and write against the API directly.

```tsx
// app/settings/page.tsx — a server component holds the key
import { AppSettingsClient } from "app-settings-js";

export default function SettingsPage() {
  return <SettingsBoard />;
}
```

```tsx
// components/settings-board.tsx
"use client";

import { AppSettingsClient } from "app-settings-js";
import { AppSettingsProvider } from "@/components/ui/app-settings/app-settings-provider";
import { SettingList } from "@/components/ui/app-settings/setting-list";
import { transportFromClient } from "@/lib/app-settings/transport";

const transport = transportFromClient(
  new AppSettingsClient({
    baseUrl: process.env.NEXT_PUBLIC_SETTINGS_URL!,
    apiKey: process.env.NEXT_PUBLIC_SETTINGS_ADMIN_KEY!,
    environment: "production",
  }),
);

export function SettingsBoard() {
  return (
    <AppSettingsProvider transport={transport} layer="server">
      <SettingList groupBy="prefix" />
    </AppSettingsProvider>
  );
}
```

> **An API key in the browser is readable by anyone using the page.** That is
> acceptable for a switchboard behind an internal auth boundary, with a key
> fenced to one environment and the scopes it needs. For anything reachable from
> the public internet, use the second shape.

### 2. Through your own API

Your server keeps the key; the browser talks to you. As long as your endpoint
returns App Settings' resolution shape, every component and hook here works
unchanged.

```tsx
"use client";

import { AppSettingsProvider } from "@/components/ui/app-settings/app-settings-provider";
import { SettingsForm } from "@/components/ui/app-settings/settings-form";
import { createHttpTransport } from "@/lib/app-settings/transport";

const transport = createHttpTransport({
  resolve: "/api/settings", // GET, with user_id / environment / platform appended
  write: "/api/settings/write", // POST { setting_id, name, layer, value, clear, … }
  credentials: "include",
});

export function Preferences({ userId }: { userId: string }) {
  return (
    <AppSettingsProvider transport={transport} userId={userId}>
      <SettingsForm groupBy="prefix" />
    </AppSettingsProvider>
  );
}
```

Routes of a different shape are described with a function:

```ts
const transport = createHttpTransport({
  resolve: (query) => `/api/users/${query.userId}/settings`,
  write: (request) => ({
    url: `/api/users/${request.userId}/settings/${request.setting.name}`,
    method: request.value === undefined ? "DELETE" : "PUT",
    body: { value: request.value },
  }),
  headers: () => ({ Authorization: `Bearer ${session.token}` }),
});
```

Leave `write` out and every control renders disabled — a read-only board is a
configuration, not a hack.

The proxy on the server is a handful of lines:

```ts
// app/api/settings/route.ts
import { AppSettingsClient } from "app-settings-js";

const client = new AppSettingsClient({
  baseUrl: process.env.SETTINGS_URL!,
  apiKey: process.env.SETTINGS_API_KEY!, // stays here
  environment: process.env.SETTINGS_ENVIRONMENT!,
});

export async function GET(request: Request) {
  const userId = new URL(request.url).searchParams.get("user_id");
  const session = await requireSession(); // your auth, not ours
  if (userId && userId !== session.userId) return new Response(null, { status: 403 });

  const snapshot = await client.resolveUser(session.userId);
  return Response.json(snapshot.toJSON());
}
```

## The components

### `<SettingField>`

One setting: its label, its description, the right control for its type, and
the state it is in.

```tsx
<SettingField name="signups.enabled" />
```

That is the whole switchboard case — it reads the resolution, writes on change,
shows which layer the value came from, disables itself when a group policy
enforces the value, and offers a reset when there is a stored value to clear.

Every part is a prop or a slot:

```tsx
<SettingField
  name="billing.tax_rate"
  label="Tax rate" // overrides the derived label
  description="Applied at checkout." // overrides the definition's
  layout="stacked" // "auto" | "inline" | "stacked"
  size="sm"
  showName={false} // hide the raw setting key
  showSource={false} // hide the layer badge
  className="rounded-lg border px-4"
  inputProps={{ commitOn: "change", placeholder: "0.00" }}
/>
```

A control this library does not ship goes in as a render prop, with the field's
state handed to you:

```tsx
<SettingField name="theme.accent">
  {({ value, onValueChange, disabled }) => (
    <ColorPicker value={String(value)} onChange={onValueChange} disabled={disabled} />
  )}
</SettingField>
```

Or compose the parts yourself — `SettingFieldHeader`, `SettingFieldLabel`,
`SettingFieldDescription`, `SettingFieldControl`, `SettingFieldMessage` — and
read `useSettingFieldContext()` inside anything of your own.

Styling hooks are on the wrapper, so a whole page can be restyled from one
place without touching the component:

```
data-slot="setting-field"   data-type="BOOLEAN"     data-source="INTERMEDIATE"
data-setting="signups.enabled"  data-enforced   data-overridden   data-dirty   data-invalid
```

```css
/* every enforced row, greyed and marked */
[data-slot="setting-field"][data-enforced] {
  opacity: 0.7;
}
```

### `<SettingList>` and `<SettingsForm>`

```tsx
// writes as each control changes
<SettingList groupBy="prefix" order={["billing", "signups"]} search={query} />

// holds edits locally and saves them together
<SettingsForm groupBy="prefix" onSaved={(r) => toast(`Saved ${r.written.length}`)} />
```

Both take `names`, `filter`, `titles`, `card` and `fieldProps`, and both accept
`renderField` / `footer` when the defaults are not what you want.

### Overriding a control everywhere

The type-to-control mapping is a registry of its own:

```tsx
<SettingInputsProvider inputs={{ NUMBER: BoundedSlider }}>
  <SettingList />
</SettingInputsProvider>
```

Per field, pass `input={BoundedSlider}`. For the whole app, edit
`settingInputs` in `setting-input.tsx` — it is your file.

## The hooks

```ts
const { snapshot, settings, isLoading } = useSettings();
const enabled = useSettingValue<boolean>("beta.enabled", false);
```

```ts
// one setting, written on change, optimistic and rolled back on failure
const { value, set, clear, canWrite, isWriting, problem, status } = useSetting("rate.limit");

await set(120); // resolves false if local validation or the request rejected it
await clear(); // fall back to the layer beneath
```

```ts
// many settings, saved together
const draft = useSettingsDraft({ names: ["rate.limit", "signups.enabled"] });

draft.setValue("rate.limit", 120);
draft.dirty; // ["rate.limit"]
draft.problems; // { "rate.limit": { rule: "max", message: "Must be 100 or less." } }
const result = await draft.save(); // { written: [...], failed: [...] }
```

`useSettingsDraft` writes one setting at a time and keeps the edits that failed,
so a partial failure leaves a form you can retry rather than a state you have to
reload to understand.

### Layers

A write lands in the layer the provider names: `server` (the default when there
is no `userId`), `personal` (the default when there is one) or `group`.

```tsx
// edit a group's policy, enforced over whatever users chose
<AppSettingsProvider transport={transport} layer="group" writeGroupId="beta" enforced>
  <SettingList />
</AppSettingsProvider>
```

Per hook or per field, pass `settingOptions={{ layer: "server" }}`.

### Validation

Values are checked against the setting's own `type_config` — bounds, length,
pattern, option membership, JSON — before a request goes out, and the failure
appears under the control. The server remains the authority; this only saves a
round trip. Turn it off with `validate={false}` on the provider.

## Working on the registry

```bash
just install          # bun install
just check            # typecheck + manifest verification + tests
just validate         # validate with the shadcn CLI itself (needs network)
just validate-remote  # validate the pushed registry, as a consumer's CLI reads it
just build            # rebuild r/, the hosted form of the registry
just items            # what a consumer sees
just list-remote      # what a consumer discovers from GitHub
just try ../my-app app-settings   # install into a real project
```

The source lives under `registry/app-settings/{lib,hooks,ui}/app-settings/` and
is authored against `@/registry/...` imports, which is what the shadcn CLI
rewrites. **`just verify` checks the part no type-checker can**: that every
declared file exists, that every `target` agrees with where imports will be
rewritten to, and that every import is covered by a declared dependency. A
missing `registryDependencies` entry is the failure that ships broken code into
someone else's project.

### Living in a monorepo

A GitHub registry is addressed as `owner/repo/<item>`, and its `registry.json`
must sit at the **repository** root — not at this package's root. So the root
manifest is three lines that point here:

```json title="../registry.json"
{
  "$schema": "https://ui.shadcn.com/schema/registry.json",
  "name": "app-settings",
  "homepage": "https://github.com/connordoman/app-settings",
  "include": ["app-settings-react/registry.json"]
}
```

With `include`, a file path is relative to the manifest that declares it, so
every path in this package's `registry.json` stays package-relative and the
package remains self-contained. The Go server and the TypeScript SDK share the
repository without being involved.

Item names are flat (`setting-field`, not `app-settings-react/setting-field`),
which is why the address is `connordoman/app-settings/setting-field`. Names may
contain `/` if the repository ever needs a second registry — everything after
`owner/repo` is the item name, never a file path.

### How imports are rewritten

The CLI maps a registry import onto the consumer's own aliases:

| Authored as                                              | Installed as                             | Lands at                             |
| -------------------------------------------------------- | ---------------------------------------- | ------------------------------------ |
| `@/registry/app-settings/ui/app-settings/setting-field`  | `<ui alias>/app-settings/setting-field`  | `@ui/app-settings/setting-field.tsx` |
| `@/registry/app-settings/hooks/app-settings/use-setting` | `<hooks alias>/app-settings/use-setting` | `@hooks/app-settings/use-setting.ts` |
| `@/registry/app-settings/lib/app-settings/values`        | `<lib alias>/app-settings/values`        | `@lib/app-settings/values.ts`        |
| `@/components/ui/switch`                                 | `<ui alias>/switch`                      | the consumer's own primitive         |
| `@/lib/utils`                                            | `<utils alias>`                          | the consumer's own `cn`              |

So a project whose `components.json` points `ui` at `@/components/shared` gets
the components at `@/components/shared/app-settings/…`, with every internal
import pointing there too. This package has no shadcn project of its own, so
[`stubs/`](./stubs) stands in for the primitives during `just typecheck`; the
stubs are never published or installed.

## License

MIT
