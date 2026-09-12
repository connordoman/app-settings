// This file is hand-written; see connect.go.

package database

import (
	"context"
	"fmt"
	"io/fs"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/tern/v2/migrate"
)

// VersionTable matches the value in tern.conf so the CLI and the server share
// one migration history.
const VersionTable = "public.schema_version"

// migrationLockID is an arbitrary constant for the advisory lock that keeps
// two instances booting at once from migrating simultaneously.
const migrationLockID int64 = 0x5e771465 // "settings"

// Migrate applies every outstanding migration. It is safe to call from every
// instance on every boot: the advisory lock serialises them and tern skips
// migrations already recorded.
func Migrate(ctx context.Context, pool *pgxpool.Pool, migrations fs.FS, onStart func(version int32, name string)) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire connection for migration: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "select pg_advisory_lock($1)", migrationLockID); err != nil {
		return fmt.Errorf("take migration lock: %w", err)
	}
	defer func() {
		// Released on a context that outlives a cancelled boot, so the lock
		// never outlives the process that took it.
		unlockCtx := context.WithoutCancel(ctx)
		_, _ = conn.Exec(unlockCtx, "select pg_advisory_unlock($1)", migrationLockID)
	}()

	migrator, err := migrate.NewMigrator(ctx, conn.Conn(), VersionTable)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}
	if onStart != nil {
		migrator.OnStart = func(version int32, name, _, _ string) { onStart(version, name) }
	}

	if err := migrator.LoadMigrations(migrations); err != nil {
		return fmt.Errorf("load migrations: %w", err)
	}
	if err := migrator.Migrate(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

// SchemaVersion reports the highest applied migration.
func SchemaVersion(ctx context.Context, pool *pgxpool.Pool) (int32, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Release()

	migrator, err := migrate.NewMigrator(ctx, conn.Conn(), VersionTable)
	if err != nil {
		return 0, err
	}
	return migrator.GetCurrentVersion(ctx)
}
