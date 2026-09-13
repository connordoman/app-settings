# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] — 2026-09-13

No changes to this package; released to stay aligned with App Settings.

## [0.1.2] — 2026-09-13

No changes to this package; released to stay aligned with App Settings.

## [0.1.1] — 2026-09-12

No changes to this package; released to stay aligned with App Settings.

## [0.1.0] — 2026-09-12

First release.

### Added

- `AppSettingsClient`, covering every route the API exposes: resolution,
  setting definitions, values in all three layers, groups and membership,
  roles, platforms, environments, and API keys.
- `SettingsSnapshot`, an immutable view over a resolution with typed accessors
  (`boolean`, `number`, `string`, `date`, `list`, `json`) and override helpers
  (`isEnforced`, `visibleOverride`, `editable`).
- `createSettingsStore`, a framework-agnostic reactive store exposing the
  `subscribe` / `getSnapshot` / `getServerSnapshot` trio that React's
  `useSyncExternalStore` consumes directly, with optimistic writes, rollback
  on rejection, and server-rendered hydration through `initialData`.
- Datetime helpers for the API's strict RFC 3339 rules: `toInstant`,
  `localToInstant`, `parseInstant`, `toDateTimeLocal`, `isInstant`.
- A single `AppSettingsError` carrying the server's `code`, `status` and
  `requestId`, with `isNotFound` / `isForbidden` / `isConflict` guards.
- Automatic retries with jittered exponential backoff on network errors, 5xx
  and 429, honouring `Retry-After` and never retrying a `POST`.

[Unreleased]: https://github.com/connordoman/app-settings/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/connordoman/app-settings/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/connordoman/app-settings/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/connordoman/app-settings/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/connordoman/app-settings/releases/tag/v0.1.0
