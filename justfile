# App Settings — development tasks.
# Run `just` to see this list.

# Local development defaults. Override any of them in the environment.
export PGHOST := env_var_or_default("PGHOST", "localhost")
export PGPORT := env_var_or_default("PGPORT", "5433")
export PGDATABASE := env_var_or_default("PGDATABASE", "settings")
export PGUSER := env_var_or_default("PGUSER", "settings")
export PGPASSWORD := env_var_or_default("PGPASSWORD", "settings")
export PGSSLMODE := env_var_or_default("PGSSLMODE", "disable")

export SETTINGS_DATABASE_URL := env_var_or_default("SETTINGS_DATABASE_URL", "postgres://settings:settings@localhost:5433/settings?sslmode=disable")
export SETTINGS_REDIS_URL := env_var_or_default("SETTINGS_REDIS_URL", "redis://localhost:6380/0")

# Computes the next version from conventional commits. Pinned and run through
# `go run`, so every machine calculates the same bump without installing it.
svu := "go run github.com/caarlos0/svu/v3@v3.4.1"

_default:
    @just --list --unsorted

# Install the code-generation and migration tools this project uses.
tools:
    go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest
    go install github.com/jackc/tern/v2@latest

# Start Postgres and Redis.
up:
    docker compose up -d --wait

# Stop them, keeping data.
down:
	docker compose down

# Stop them and delete the data volume.
reset:
	docker compose down --volumes

# Regenerate the sqlc query layer from queries/ and migrations/.
generate:
    sqlc generate

# Verify the generated code is current — for CI, where a stale commit should fail.
generate-check: generate
    @git diff --exit-code --stat internal/database \
      || (echo "internal/database is stale: run 'just generate' and commit the result" && exit 1)

# Apply all outstanding migrations.
migrate:
    tern migrate --migrations ./migrations --config ./tern.conf

# Roll back the most recent migration.
migrate-down:
    tern migrate --migrations ./migrations --config ./tern.conf --destination -1

# Show the current schema version.
migrate-status:
    tern status --migrations ./migrations --config ./tern.conf

# Scaffold a migration: just new-migration add_widget_table
new-migration name:
    tern new --migrations ./migrations {{name}}

# Build both binaries into bin/.
build:
    go build -o bin/app-settings ./cmd/app-settings
    go build -o bin/settingsctl ./cmd/settingsctl

# Run the server against the local stack.
run:
    go run ./cmd/app-settings

# Run the CLI: just ctl keys list
ctl *args:
    go run ./cmd/settingsctl {{args}}

# Generate shell completion scripts into bin/.
completions: build
    @mkdir -p bin/completions
    @for shell in bash zsh fish powershell; do \
        ./bin/settingsctl completion $shell > bin/completions/settingsctl.$shell ; \
    done
    @echo "wrote bin/completions/settingsctl.{bash,zsh,fish,powershell}"

test:
    go test ./...

# Tests that need the local Postgres from `just up`.
test-integration:
    go test -tags=integration -count=1 ./...

# Formatting and vet.
lint:
    @test -z "$(gofmt -l .)" || (gofmt -l . ; echo "unformatted files above; run 'just fmt'" ; exit 1)
    go vet ./...
    go vet -tags=integration ./...

fmt:
    gofmt -w .

# Everything CI runs for the server.
check: lint test generate-check

# Bring up a clean stack, migrate and start the server.
dev: up migrate run

# --- TypeScript SDK (app-settings-js) -----------------------------------------

# Run a recipe from the SDK's own justfile: just sdk test
sdk *args:
    @cd app-settings-js && just {{args}}

# Type-check and test the SDK.
sdk-check:
    @cd app-settings-js && just check

# Build the SDK's bundles and declarations.
sdk-build:
    @cd app-settings-js && just build

# --- React registry (app-settings-react) --------------------------------------

# Run a recipe from the registry's own justfile: just ui build
ui *args:
    @cd app-settings-react && just {{args}}

# Type-check, verify the manifest and test the registry.
ui-check:
    @cd app-settings-react && just check

# Rebuild the hosted registry JSON in app-settings-react/r/.
ui-build:
    @cd app-settings-react && just build

# Everything CI runs: server, SDK, registry, and that their versions agree.
check-all: check sdk-check ui-check version-check

# --- Releases -----------------------------------------------------------------
# The server, SDK and registry share one version. `just bump` writes it into
# every file that carries it; merge that, then `just release` tags main.

# Print the version the repository is at.
version:
    @bun scripts/version.ts current

# Fail if any package disagrees with the others, or with a tag: just version-check v0.2.0
version-check tag="":
    @bun scripts/version.ts check {{tag}}

# Preview the version the commits since the last tag call for.
version-next:
    @{{svu}} next

# Move every package to one version: just bump (from commits) or just bump 0.2.0
# svu reads a breaking change as a major even below 1.0; pass a version to stay on 0.x.
bump version="":
    #!/usr/bin/env bash
    set -euo pipefail
    next="{{version}}"
    [[ -n "$next" ]] || next="$({{svu}} next)"
    bun scripts/version.ts set "$next"
    just ui-build
    echo "review app-settings-js/CHANGELOG.md, then commit: chore(release): v${next#v}"

# Validate .goreleaser.yaml.
release-check:
    goreleaser check

# Build the full release into dist/ without tagging or publishing anything.
release-snapshot:
    goreleaser release --snapshot --clean

# Tag main at the version its files declare and push; the release workflow publishes.
release:
    #!/usr/bin/env bash
    set -euo pipefail
    tag="v$(bun scripts/version.ts current)"
    [[ "$(git branch --show-current)" == main ]] || { echo "release from main"; exit 1; }
    git diff --quiet HEAD || { echo "working tree is dirty; commit first"; exit 1; }
    git fetch --quiet --tags origin main
    [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
      || { echo "main is not at origin/main; pull or push first"; exit 1; }
    ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null \
      || { echo "$tag already exists; run 'just bump' and merge it first"; exit 1; }
    bun scripts/version.ts check "$tag"
    git tag -a "$tag" -m "$tag"
    git push origin "$tag"

build-snapshot:
    goreleaser build --snapshot --clean --single-target
