// Package store wraps the generated query layer with transactions and turns
// PostgreSQL's error codes into problems an API handler can report usefully.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/connordoman/settings-app/internal/database"
)

// Store owns the connection pool and the generated queries bound to it.
type Store struct {
	pool *pgxpool.Pool
	*database.Queries
}

// New binds a store to a pool.
func New(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool, Queries: database.New(pool)}
}

// Pool exposes the underlying pool for health checks and migrations.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// InTx runs fn inside a transaction, rolling back if it returns an error.
func (s *Store) InTx(ctx context.Context, fn func(*database.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin transaction: %w", err)
	}
	// Rolling back a committed transaction is a no-op, so this is safe to defer
	// unconditionally.
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(s.Queries.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit transaction: %w", err)
	}
	return nil
}

// Sentinel errors the API layer maps onto status codes.
var (
	// ErrNotFound means the addressed row does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict means the write collided with an existing row.
	ErrConflict = errors.New("conflict")
	// ErrInvalid means the database rejected the write as inconsistent.
	ErrInvalid = errors.New("invalid")
)

// IsNotFound reports whether err is a missing-row error from any layer.
func IsNotFound(err error) bool {
	return errors.Is(err, pgx.ErrNoRows) || errors.Is(err, ErrNotFound)
}

// Classify converts a database error into one of the sentinels above, keeping
// PostgreSQL's own message as the explanation. Constraint names are chosen in
// the migrations to read well here.
func Classify(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}

	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}

	switch pgErr.Code {
	case "23505": // unique_violation
		return fmt.Errorf("%w: %s", ErrConflict, describeUnique(pgErr))
	case "23503": // foreign_key_violation
		// The same code covers two opposite mistakes: pointing at a row that
		// does not exist, and deleting a row something still points at.
		if strings.Contains(pgErr.Detail, "is still referenced") {
			return fmt.Errorf("%w: %s", ErrConflict, describeStillReferenced(pgErr))
		}
		return fmt.Errorf("%w: %s", ErrInvalid, describeForeignKey(pgErr))
	case "23514", // check_violation, including the layer and environment guards
		"23502", // not_null_violation
		"22000", // data_exception, raised by the slug domain
		"22P02": // invalid_text_representation
		return fmt.Errorf("%w: %s", ErrInvalid, pgErr.Message)
	case "P0001": // raise_exception from a trigger
		return fmt.Errorf("%w: %s", ErrInvalid, pgErr.Message)
	}
	return err
}

func describeUnique(pgErr *pgconn.PgError) string {
	switch pgErr.ConstraintName {
	case "settings_name_unique_per_target":
		return "a setting with that name already exists for this platform and environment"
	case "groups_name_unique_per_environment":
		return "a group with that name already exists in this environment"
	case "intermediate_settings_one_per_group":
		return "this group already overrides that setting"
	case "personal_settings_one_per_user":
		return "this user already has a value for that setting"
	case "api_keys_single_bootstrap":
		return "a bootstrap key already exists"
	case "roles_rank_key":
		return "another role already has that rank"
	}
	if pgErr.Detail != "" {
		return pgErr.Detail
	}
	return pgErr.Message
}

// describeStillReferenced explains a delete blocked by dependent rows.
func describeStillReferenced(pgErr *pgconn.PgError) string {
	if pgErr.Detail != "" {
		return strings.TrimSuffix(pgErr.Detail, ".") + "; remove or repoint those rows first"
	}
	return pgErr.Message
}

func describeForeignKey(pgErr *pgconn.PgError) string {
	switch pgErr.ConstraintName {
	case "settings_role_fkey":
		return "no such role"
	case "settings_platform_fkey":
		return "no such platform"
	case "settings_environment_fkey", "groups_environment_fkey":
		return "no such environment"
	case "api_keys_role_fkey":
		return "no such role"
	}
	return pgErr.Message
}
