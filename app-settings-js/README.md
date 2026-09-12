# app-settings-js

A TypeScript SDK for the [App Settings](../README.md) API.

- **No dependencies.** Nothing but the platform's own `fetch`.
- **Runs anywhere.** Browsers, Node 18+, Bun, Deno, and edge runtimes. ESM and CJS.
- **React-ready, React-free.** No React import anywhere in this package. The
  store exposes the `subscribe` / `getSnapshot` pair `useSyncExternalStore`
  wants, so React is three lines away — and so are Vue, Svelte and Solid.

```sh
bun add app-settings-js   # or npm / pnpm / yarn
```

## Quick start

```ts
import { AppSettingsClient } from "app-settings-js";

const client = new AppSettingsClient({
  baseUrl: "https://settings.example.com",
  apiKey: process.env.SETTINGS_API_KEY!,
  environment: "production",
});

const settings = await client.resolveUser("alice");

settings.boolean("dark_mode");          // false
settings.number("page_size", 25);       // 25 if unset
settings.string("theme");
settings.date("digest_at");             // a Date
settings.json<Limits>("rate_limits");
```

`resolveUser` returns a [`SettingsSnapshot`](#the-snapshot): every setting the
user can see, already collapsed to one effective value each. That is the call a
product backend makes, and usually the only one it needs.

> **Where this runs.** The API key is a server credential. Settings are meant to
> be read through your own backend, which authenticates the user first. Putting
> a key in a browser bundle hands every visitor whatever that key can reach.
> Front ends should call your server, and hydrate a store from what it returns —
> see [Server rendering](#server-rendering).

## The snapshot

A snapshot is immutable, and its identity changes only when the data does, which
is what lets a UI framework skip a re-render.

```ts
settings.has("dark_mode");          // is it visible to this role at all?
settings.isSet("dark_mode");        // did any layer, or the default, supply a value?
settings.source("dark_mode");       // "PERSONAL" | "SERVER" | "DEFAULT" | ...
settings.get("dark_mode");          // the whole ResolvedSetting
settings.toObject();                // { dark_mode: false, page_size: 25, ... }

for (const setting of settings) { /* iterable, in the server's order */ }
```

Typed accessors return the fallback when a setting is unset or invisible to the
role, and **throw** when the setting exists but holds another type — which can
only mean the wrong name was asked for:

```ts
settings.string("dark_mode");
// AppSettingsError: setting "dark_mode" is declared BOOLEAN and holds a boolean, not a string
```

`list()` covers `SELECT`, returning a single choice as a one-element array so no
caller has to branch on `multiple`:

```ts
settings.list<string>("tags");   // ["a", "b"]
settings.options("tags");        // [["A", "a"], ["B", "b"]] for a picker
```

### Overrides

A group override is either **advisory** (a group-wide default the user's own
value beats) or **enforced** (a policy that beats it). Orthogonally, an override
may be marked invisible, meaning the user is not meant to observe it.

```ts
settings.isEnforced("retention_days");     // disable the control
settings.visibleOverride("retention_days"); // the override you may tell them about
settings.override("retention_days");        // the raw one, visible or not
settings.editable();                        // personal scope, not enforced
```

`visibleOverride` is the accessor a UI should reach for: it withholds an
override the server marked `visible: false`, so a snapshot cannot leak one by
accident.

## The store

`createSettingsStore` keeps one resolution current and tells subscribers when it
changes. It handles the parts that are tedious to get right: no fetch until
something is listening, one request shared between concurrent refreshes, stale
responses dropped, and the last good snapshot kept when a refresh fails.

```ts
import { createSettingsStore } from "app-settings-js";

const store = createSettingsStore(client, {
  userId: "alice",
  refreshIntervalMs: 60_000,
  revalidateOnFocus: true,
});

store.subscribe(() => console.log(store.getSnapshot().snapshot?.toObject()));
await store.set("dark_mode", true);   // optimistic, rolled back if rejected
await store.clear("dark_mode");       // fall back to the layer beneath
```

`getSnapshot()` returns a `SettingsState`:

| Field | Meaning |
| --- | --- |
| `status` | `idle` before the first load, then `loading`, `ready` or `error` |
| `snapshot` | the current `SettingsSnapshot`, or `null` before the first one |
| `error` | why the last load failed; cleared by a successful one |
| `isValidating` | a request is in flight, including a background refresh |
| `updatedAt` | when the current snapshot arrived |

`refresh()` never rejects — the failure lands in `error` — so a caller needs no
`try`/`catch`. `set()` and `clear()` do reject, because a rejected write is
something the caller has to react to.

### React

There is no React module here, and there does not need to be one. Paste this
into your app:

```tsx
import { useSyncExternalStore } from "react";
import { createSettingsStore, type SettingsStore } from "app-settings-js";

const store = createSettingsStore(client, { userId: currentUserId });

function useSettings(store: SettingsStore) {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

function DarkModeToggle() {
  const { snapshot, status } = useSettings(store);
  if (!snapshot) return status === "error" ? <Failed /> : <Spinner />;

  return (
    <label>
      <input
        type="checkbox"
        checked={snapshot.boolean("dark_mode")}
        disabled={snapshot.isEnforced("dark_mode")}
        onChange={(event) => store.set("dark_mode", event.target.checked)}
      />
      Dark mode
      {snapshot.visibleOverride("dark_mode") && <Badge>Set by your team</Badge>}
    </label>
  );
}
```

`getSnapshot` returns the same object until something actually changes, which is
exactly the contract `useSyncExternalStore` enforces, and `getServerSnapshot`
makes the store safe to render on a server.

The same two functions adapt anywhere: Svelte's `readable`, Vue's
`shallowRef` plus `onScopeDispose`, or a Solid signal.

### Server rendering

Resolve on the server, serialise the response into the page, and hand it to the
store so the first render already has data and no request is made:

```ts
// server
const settings = await client.resolveUser(userId);
return { props: { settings: settings.toJSON() } };

// client
const store = createSettingsStore(client, { userId, initialData: props.settings });
```

## Writing values

Each layer has its own namespace, mirroring the API's routes:

```ts
await client.values.server.set(settingId, true);
await client.values.personal.set(settingId, "alice", "solarized");
await client.values.group.set(settingId, groupId, false, {
  enforced: true,   // beats the user's own value
  visible: false,   // the user is not meant to observe it
});

await client.values.personal.clear(settingId, "alice");
```

`undefined` is refused before a request is made — clearing a value is `clear()`,
which is a `DELETE`. `null` goes through, because it is a legitimate JSON value.

## Definitions, groups, taxonomy and keys

```ts
await client.settings.list({ scope: "PERSONAL" });
await client.settings.create({
  name: "page_size",
  type: "NUMBER",
  scope: "PERSONAL",
  platform: "web",
  typeConfig: { min: 10, max: 100, integer: true },
  defaultValue: 25,
});
await client.settings.delete(id, { cascade: true });   // required if values exist

await client.groups.create({ name: "beta", members: ["alice"], priority: 10 });
await client.groups.addMembers(groupId, ["bob"]);

await client.taxonomy.roles();
await client.taxonomy.upsertRole("auditor", { rank: 25 });

const minted = await client.keys.create({ name: "web backend", scopes: ["resolve"] });
minted.token;   // the only time it is ever available
```

## Datetimes

`DATETIME` accepts only a strict RFC 3339 value with an offset, because an
offset is what makes a value an instant rather than a wall-clock reading. A
`Date` satisfies that automatically; `<input type="datetime-local">` does not.

```ts
import { localToInstant, parseInstant, toDateTimeLocal, toInstant } from "app-settings-js";

toInstant(new Date());                              // "2026-01-02T20:04:05.250Z"
toInstant("2026-01-02T15:04:05-05:00");             // "2026-01-02T20:04:05.000Z"
toInstant("2026-01-02T15:04");                      // throws, naming the problem

localToInstant("2026-01-02T15:04", "America/New_York");  // "2026-01-02T20:04:00.000Z"
toDateTimeLocal(value, "America/New_York");              // back into the input
parseInstant(settings.value("digest_at"));               // a Date
```

Passing the timezone to `localToInstant` is the point: the same reading is a
different moment in every zone, so the SDK makes you say which one rather than
guessing. `store.set()` converts a `Date` for you.

## Errors

Everything throws one class. Branch on `code`, which is stable, not on the
message, which is written for a human.

```ts
import { AppSettingsError, isNotFound, isForbidden } from "app-settings-js";

try {
  await client.settings.get(id);
} catch (error) {
  if (isNotFound(error)) return null;
  if (isForbidden(error)) throw new Error("this key is fenced out of that environment");
  if (AppSettingsError.is(error)) {
    error.code;       // "not_found" | "forbidden" | "network_error" | "timeout" | ...
    error.status;     // 404
    error.requestId;  // the server's X-Request-ID, worth quoting in a bug report
    error.retryable;
  }
  throw error;
}
```

A key fenced out of an environment gets `not_found` rather than `forbidden` for
a setting inside it — the server declines to reveal that it exists.

Failed requests are retried automatically on network errors, 5xx and 429, with
exponential backoff and jitter, honouring `Retry-After`. `POST` is never
retried, being the only non-idempotent method in the API. Tune it per client:

```ts
new AppSettingsClient({ baseUrl, apiKey, retries: 5, retryDelayMs: 100, timeoutMs: 5_000 });
```

Every call also takes `{ signal, timeoutMs, headers }` for a one-off override.

## Testing against it

The client takes any `fetch`, so tests need no network and no mocking library:

```ts
const client = new AppSettingsClient({
  baseUrl: "https://settings.test",
  apiKey: "as_test",
  environment: "test",
  fetch: async () => new Response(JSON.stringify(fixture), { status: 200 }),
});
```

## Development

```sh
just            # list every recipe
just check      # typecheck + test
just build      # ESM, CJS and declarations into dist/
just test       # bun test
```

From the repository root, `just sdk <recipe>` reaches these, and `just
check-all` runs the server's checks and the SDK's together.
