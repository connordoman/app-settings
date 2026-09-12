# App Settings

A standalone REST API server written in Go that can utilize any PostgreSQL database along with an optional Redis instance to serve role-based well-described settings, scoped Personal, Intermediate or Server.

_Personal_ is scoped to the user. Settings are defined by the platform, and everyone has their own version of the response.

_Intermediate_ is an optional layer that defines bidirectional overrides. They may visibly inform the user of the override, or the user may not observe a changed setting due to the override. Intermediate settings can be declared against a Group of users, which can be ad-hoc and/or saved for future use.

_Server_ is scoped to the server. These settings apply to the behavior of the server, like global filter modes or what client-side features are enabled.

_Roles_ are a user-defined field, and default to `user`, `staff`, and `admin`. In this example, User may have only Personal Settings, while Staff may have some Intermediate and some Server, and Admin has access to everything.

Settings have a _Platform_ that defines where they are able to apply. This is a user-defined value like `web`, `mobile`, or `server`. Server exists by default, and cannot be removed.

The user will need an API key to access the service, so API keys are stored alongside settings. Settings should be accessed via the user's server, where authentication against the client's credentials will occur.

Settings can be scoped to a user-defined environment, like "development", "staging", or "production". API keys can filter access by environment, to ensure no cross-pollination.

## Quick start

App Settings is self-hosted: you run it against your own PostgreSQL.

```sh
just tools     # install sqlc and tern
just up        # start PostgreSQL and Redis via docker compose
just run       # migrate and serve on :8080
```

On its **first boot against an empty database**, the server prints a bootstrap
API key to stdout. It is shown once and never stored in recoverable form:

```text
══════════════════════════════════════════════════════════════════════════
  BOOTSTRAP API KEY — shown once, never recoverable
══════════════════════════════════════════════════════════════════════════

  as_5dm8m6kk5ed1_gJw9_B2u6g4SSzLqAsaPENNOK_UGA8OmtOYmcMrJBEM

  This key can only manage other API keys (keys:read, keys:write).
```

That key exists solely to break the chicken-and-egg problem of a server whose
API requires a key. Use the CLI to mint the keys your services will really use:

```sh
export SETTINGS_URL=http://localhost:8080
export SETTINGS_API_KEY=as_5dm8m6kk5ed1_...   # the bootstrap key

settingsctl keys create --name "web backend" \
    --scope resolve --scope values:write \
    --env production --platform web --role user
```

The new token is printed on stdout alone, so it can be piped straight into a
secret store; everything else goes to stderr.

## Settings

A Setting has:

- `id`
- `name` — unique per `platform` + `environment`
- `description`
- `type`
- `type_config` — the rules for that type (see below)
- `role`
- `scope`
- `platform`
- `environment`
- `default_value` — the out-of-box value, used when no layer supplies one
- `created_at`
- `created_by`
- `updated_at`
- `updated_by`

A Personal Setting has:

- `id`
- `user_id`
- `setting_id`
- `value` // JSONB
- `created_at`
- `created_by`
- `updated_at`
- `updated_by`

An Intermediate Setting has:

- `id`
- `group_id`
- `setting_id`
- `value` // JSONB
- `visible` // is the override visible from the user's perspective?
- `is_enforced` // does it beat the user's own value, or yield to it?
- `created_at`
- ...

A Server Setting has:

- `id`
- `setting_id`
- `value` // JSONB
- `created_at`
- ...

A `type` is any of:

- `BOOLEAN`
  - `true`/`false`
- `NUMBER`
  - -1, 0.0, 1, 1.5
- `STRING`
  - `"hello"`, `"my-date-filter"`
- `DATETIME`
  - `2026-01-02T15:04:05Z`, `2026-01-02T15:04:05-05:00`
- `SELECT`
  - `{ type: "STRING", options: [["Red", "#ff0000"], ["Green", "#00ff00"], ["Blue", "#0000ff"]] }`
- or `JSON`.

Ultimately, a `value` is stored as `JSONB`, so JSON is the "any" type.

### Type rules

`type_config` carries the rules for a type. Values are validated against it on
every write and stored in canonical form, so `"2026-01-02T15:04:05-05:00"` comes
back as `"2026-01-02T20:04:05Z"` and two equal values are always byte-equal in
the database.

| Type | Options |
| --- | --- |
| `NUMBER` | `min`, `max`, `integer` |
| `STRING` | `min_length`, `max_length`, `pattern` (RE2, anchored to the whole value) |
| `SELECT` | `type`, `options`, `multiple` |
| `DATETIME` | none — the format is fixed |

## Datetimes and timezones

There is one temporal type, `DATETIME`, and it holds one instant. A value must
be a strict RFC 3339 `date-time`:

```text
date-time = full-date "T" full-time
          = 2026-01-02 T 15:04:05[.fraction] (Z | ±hh:mm)
```

**The offset is mandatory, and that one requirement is what makes everything
else simple.** A datetime carrying an offset denotes an unambiguous point on the
timeline, so it can be converted to UTC on the way in and stored in a single
canonical form. A datetime _without_ an offset is not an instant at all — it is
a wall-clock reading that means a different moment in every zone — so there
would be no correct way to convert it.

Values are normalised to UTC. The same moment written three ways is stored
identically:

```text
2026-01-02T15:04:05-05:00  ─┐
2026-01-03T05:04:05+09:00  ─┼─►  "2026-01-02T20:04:05Z"
2026-01-02T20:04:05Z       ─┘
```

That also means values sort and compare correctly as plain strings: for two
RFC 3339 values that both end in `Z`, lexicographic order is chronological
order.

### From a browser

`Date.prototype.toISOString()` emits exactly this shape, and `JSON.stringify`
calls it automatically, so a `Date` in a request body just works:

```js
await fetch(url, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  // -> {"value":"2026-01-02T20:04:05.250Z"}
  body: JSON.stringify({ value: new Date() }),
});
```

The one thing to watch is `<input type="datetime-local">`, which yields
`2026-01-02T15:04` — no seconds and no offset. That is a wall-clock reading, so
it is rejected. Convert it first, which also makes the assumption explicit:

```js
// Interprets the input in the browser's own zone and yields a real instant.
const value = new Date(input.value).toISOString();
```

These are rejected, each with an error naming the specific problem:

| Sent | Why |
| --- | --- |
| `2026-01-02T15:04:05` | No offset, so not an instant |
| `2026-01-02T15:04` | `datetime-local`; no seconds and no offset |
| `2026-01-02` | A date alone |
| `2026-01-02T15:04:05-0500` | RFC 3339 requires the colon in the offset |
| `2026-01-02 15:04:05Z` | Separator must be `T`, not a space |
| `2026-01-02T23:59:60Z` | Leap second; RFC 3339 allows it, Go cannot hold it |

Lower-case `t` and `z` are accepted, since RFC 3339 §5.6 permits them; canonical
output is upper case. A fractional part is optional and preserved, with a
redundant trailing zero trimmed (`.250` stores as `.25`, the same instant —
`new Date()` round-trips it back to `.250`). RFC 3339 §4.3 uses `-00:00` to mean
"offset unknown"; normalising to UTC necessarily renders that as `Z`.

### What this deliberately gives up

A single instant cannot express a _recurring wall-clock intent_ — "send the
digest at 09:00 New York time". That is not one moment; it is a different moment
each day, and its future UTC values are not knowable in advance, because
governments change daylight-saving rules. If you need one, model it explicitly
rather than as a `DATETIME`: a `STRING` for the time-of-day plus a `STRING` for
the IANA zone, or a `JSON` value holding both. Storing such an intent as an
instant is the bug this type is shaped to avoid, not a use it supports.

### Why not let PostgreSQL parse it

PostgreSQL's `timestamptz` does exactly the conversion described above: it
parses the offset, stores the instant as UTC, and renders it back in the
session's `TimeZone`. It is the right column type for an instant, and it is what
`created_at` and `updated_at` use.

It is the wrong thing to point at untrusted API input, though. Its parser is
far more permissive than RFC 3339 — it takes `2026-01-02 15:04:05`, bare dates,
`now`, `infinity`, and formats whose meaning depends on the session's
`DateStyle`, so `01/02/2026` is January 2nd or February 1st depending on a
server setting. A value with no offset is silently assumed to be in the
server's timezone. So validation happens in Go, strictly, and PostgreSQL is
handed something already unambiguous.

Note also that `timestamptz` stores **no timezone at all**, despite the name.
It stores an instant; the input offset is used for the conversion and then
discarded. That matters for the next part.

### On inferring location from an offset

It is tempting to keep the submitted offset as a hint about where someone was.
It is a much weaker signal than it looks, and a VPN is the least of it:

- **An offset is not a location.** `-05:00` in January covers New York,
  Toronto, Bogotá, Lima, Kingston and Havana; in July it is Chicago, Mexico City
  and Winnipeg instead. It is a coarse longitude band, not a place.
- **An offset is not even a timezone.** You cannot recover the zone from it, so
  you cannot tell `America/New_York` in winter from `America/Chicago` in summer.
- **It is self-reported and unauthenticated.** The client sends whatever it
  likes, and a browser reports its _own clock's_ offset — an OS setting, not a
  network fact. A VPN does not change it, so it is not even a VPN detector; and
  someone in Berlin with their laptop set to New York reports `-05:00`.
- **It tracks travel, not residence**, and changes twice a year under DST.
- **It is inferred personal data**, which makes it a compliance question the
  moment you store it for that purpose.

So the offset is not retained as a location signal. If you want the actor's
local time — a legitimate thing to want, for reproducing a report or showing
"you changed this at 3pm your time" — capture it as its own explicit field with
the IANA zone the client states, rather than inferring it from a timestamp.
`created_at` and `updated_at` stay what they are: instants, in UTC.

One pleasant consequence of requiring the offset: the server never has to look
up an IANA timezone, because an RFC 3339 offset defines a fixed zone on its own.
The binary no longer embeds the tzdata database at all.

## Resolution

`GET /api/v1/resolve/user/:user_id` returns every setting a user can see,
already collapsed to one effective value. Precedence, lowest to highest:

```text
default_value < server < intermediate (advisory) < personal < intermediate (enforced)
```

This is what makes the intermediate layer _bidirectional_. A group override is
written in one of two directions:

- **advisory** (`is_enforced: false`) — a group-wide default. The user's own
  value beats it.
- **enforced** (`is_enforced: true`) — a policy. It beats the user's own value.

`visible` is orthogonal, and is a directive to the backend calling the API: when
`false`, the user is not meant to observe that anything was overridden. The
override block is still returned, because the caller is the user's own server
and may need to know; it just should not surface it.

```jsonc
{
  "name": "dark_mode",
  "value": false,
  "source": "INTERMEDIATE",
  "override": {
    "group_id": "f683b3c7-...",
    "enforced": true,
    "visible": false,
    "replaced_value": true   // what the user had chosen, so you can restore it
  }
}
```

`source` is one of `UNSET`, `DEFAULT`, `SERVER`, `INTERMEDIATE`, `PERSONAL`.

SERVER-scoped settings appear in a user resolution too — a client needs them to
know which features are switched on. What a caller may see is bounded by role,
not by scope.

### Groups

Groups carry the intermediate layer. A user's groups are found by membership,
and a group may also be applied **ad-hoc** by naming it on the request:

```sh
GET /api/v1/resolve/user/alice?environment=production&group_id=<uuid>
```

That applies the group without storing membership. When a user is in several
groups that override the same setting, the highest `priority` wins; the older
group breaks a tie, so the result is stable.

## Roles, platforms and environments

All three are user-defined. Roles carry a `rank`: a setting declared for
`staff` is visible to every role ranked at or above `staff`. The defaults are
`user` (10), `staff` (20) and `admin` (30).

The `server` platform is seeded and cannot be removed. Everything else may be
added, renamed or deleted, and a delete is refused while settings still
reference it.

## API keys

A token looks like:

```text
as_k3n8qv2mx7wd_7Hf2qN...
│  │             └ secret: 32 CSPRNG bytes, base64url, never stored
│  └ prefix: stored in the clear and uniquely indexed
└ fixed label, so a leaked key is recognisable in logs and secret scanners
```

Only `sha256(token)` is persisted. A password KDF such as argon2 exists to slow
down guessing a _low-entropy human_ secret; against 256 bits of CSPRNG output it
buys nothing measurable, and it would put a deliberately slow hash on every
authenticated request. The public prefix makes the lookup a single indexed read,
so exactly one hash is computed and compared in constant time.

A key carries:

- **scopes** — `resolve`, `settings:read`, `settings:write`, `values:read`,
  `values:write`, `groups:read`, `groups:write`, `taxonomy:read`,
  `taxonomy:write`, `keys:read`, `keys:write`, or `*` for all.
- **environments** and **platforms** — empty means all. This is the fence that
  stops cross-pollination: a staging key cannot read production, and does not
  even learn which settings exist there.
- **role** — a ceiling. A `user`-role key can never see a setting declared for
  `admin`, nor ask to resolve as one.
- **expiry**, and revocation, which is permanent and takes effect immediately.

A key may never mint one that reaches further than itself: environment and
platform filters can only be narrowed, and the role can only be equal or lower.
Note that `keys:write` is inherently privileged — anything holding it can mint
keys — so grant it sparingly.

The **bootstrap key** is the single key created at first boot. It holds
`keys:read` and `keys:write` and nothing else, so it provides CLI access only.
Exactly one can ever exist, enforced by a partial unique index.

## CLI

`settingsctl` manages keys against a live instance. It is a
[Cobra](https://github.com/spf13/cobra) CLI, so every command carries its own
`--help` and the usual conventions apply.

```sh
settingsctl keys create --name NAME --scope SCOPE [--env ENV] [--platform P]
                        [--role ROLE] [--expires-in 720h] [--json]
settingsctl keys list [--include-revoked] [--json]
settingsctl keys revoke <key-id>
settingsctl whoami
settingsctl health
settingsctl version
```

`--scope`, `--env` and `--platform` are repeatable and also accept a
comma-separated list: `--scope keys:read,keys:write`.

The server is reached at `--url` (default `http://localhost:8080`) and
authenticated with `--api-key`; both fall back to `SETTINGS_URL` and
`SETTINGS_API_KEY`, which is the usual way to set them.

`keys create` prints the new token to **stdout on its own line** and everything
else to stderr, so it pipes cleanly into a secret store:

```sh
settingsctl keys create --name "web backend" --scope resolve | pbcopy
```

Shell completion comes from Cobra — `settingsctl completion zsh --help` explains
where to install it. `just completions` writes all four scripts to `bin/`.

The server binary is a Cobra command too: `app-settings` serves the API and
`app-settings version` prints its version. It takes no flags; configuration is
entirely environmental.

## HTTP API

Every route below `/api/v1` requires `Authorization: Bearer <key>` (or
`X-API-Key`). Errors are always `{"error": {"code": ..., "message": ...}}`.

| Method | Path | Scope |
| --- | --- | --- |
| `GET` | `/healthz`, `/readyz` | none |
| `GET` | `/api/v1/whoami` | any |
| `GET` `POST` | `/api/v1/keys` | `keys:read` / `keys:write` |
| `DELETE` | `/api/v1/keys/:id` | `keys:write` |
| `GET` | `/api/v1/roles`, `/platforms`, `/environments` | `taxonomy:read` |
| `PUT` `DELETE` | `/api/v1/roles/:name`, … | `taxonomy:write` |
| `GET` `POST` | `/api/v1/settings` | `settings:read` / `settings:write` |
| `GET` `PATCH` `DELETE` | `/api/v1/settings/:id` | `settings:read` / `settings:write` |
| `GET` `PUT` `DELETE` | `/api/v1/settings/:id/server` | `values:read` / `values:write` |
| `GET` `PUT` `DELETE` | `/api/v1/settings/:id/personal/:user_id` | `values:read` / `values:write` |
| `GET` `PUT` `DELETE` | `/api/v1/settings/:id/intermediate/:group_id` | `values:read` / `values:write` |
| `GET` `POST` | `/api/v1/groups` | `groups:read` / `groups:write` |
| `GET` `PATCH` `DELETE` | `/api/v1/groups/:id` | `groups:read` / `groups:write` |
| `GET` `POST` `DELETE` | `/api/v1/groups/:id/members` | `groups:read` / `groups:write` |
| `GET` | `/api/v1/resolve/user/:user_id` | `resolve` |
| `GET` | `/api/v1/resolve/server` | `resolve` |

A setting's `type`, `scope`, `platform` and `environment` are fixed at creation:
changing them would invalidate values already stored against it. Deleting a
setting cascades to its values, so a delete that would destroy any is refused
unless you repeat it with `?cascade=true`.

## Configuration

Everything is environment variables; only the database is required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SETTINGS_DATABASE_URL` | — | PostgreSQL connection string. The standard `PG*` variables work too. |
| `SETTINGS_REDIS_URL` | unset | Enables the resolution cache. Entirely optional. |
| `SETTINGS_CACHE_TTL` | `60s` | How long a cached resolution is served. |
| `SETTINGS_LISTEN_ADDR` | `:8080` | |
| `SETTINGS_AUTO_MIGRATE` | `true` | Apply embedded migrations at boot. |
| `SETTINGS_TRUSTED_PROXIES` | empty | CIDRs whose `X-Forwarded-For` is believed. Empty trusts none. |
| `SETTINGS_LAST_USED_THROTTLE` | `5m` | Minimum gap between `last_used_at` writes per key. |
| `SETTINGS_DEBUG` | `false` | |

Redis is genuinely optional — without it the server behaves identically, just
with more database reads. Cached entries are tracked per environment and dropped
whenever a write could change what a resolution returns.

## Development

PostgreSQL 14+ is required (`gen_random_uuid()`).

```sh
just            # list every recipe
just up         # docker compose: PostgreSQL on 5433, Redis on 6380
just migrate    # apply migrations with tern
just generate   # regenerate the sqlc query layer
just test       # unit tests
just test-integration   # tests that need the database from `just up`
just check      # lint + test + generated-code freshness
```

- **Migrations** are [tern](https://github.com/jackc/tern) files in
  `migrations/`, applied by the CLI in development and from the binary's own
  embedded copy at boot. Concurrent instances serialise on an advisory lock.
- **Queries** live in `queries/` and are compiled to Go by
  [sqlc](https://sqlc.dev) into `internal/database`. That directory is
  generated: change the SQL, then `just generate`.
- The schema does its own share of the work. A `slug` domain constrains every
  user-defined name, triggers keep `updated_at` honest, and a trigger refuses
  any value written to a layer the setting's scope forbids — so the invariant
  holds even for something writing to the database directly.

## Releasing

The server, the TypeScript SDK and the React registry share one version, so
`v0.4.0` of any of them works with `v0.4.0` of the others. A release that
changes only one package still moves them all; the others simply ship nothing
new.

```sh
just version-next   # what the commits since the last tag call for
just bump           # write that version everywhere (or: just bump 0.4.0)
# review app-settings-js/CHANGELOG.md, open a PR, merge it
just release        # on an up-to-date main: tag v0.4.0 and push
```

The bump follows conventional commits across the whole repository: any `fix`
is a patch, any `feat` a minor, and any `!` or `BREAKING CHANGE` a major. Below
1.0, pass the version to `just bump` to keep a breaking change on `0.x`. From
v2 the Go module path needs a `/vN` suffix, and `just bump` refuses to cross
that line until go.mod has it.

Pushing the tag runs `.github/workflows/release.yml`, which refuses to publish
unless the tag is on main, every package's version matches it, and
`just check-all` passes. It then publishes the Go binaries to a GitHub release,
announces the module to the Go proxy, and publishes the SDK to npm (prereleases
under the `next` dist-tag). The registry needs no publishing: consumers install
it from the tag, `connordoman/app-settings/<item>#v0.4.0`.

`just version-check` runs in `just check-all`, so a hand-edited version that
drifts fails before it can be merged.
