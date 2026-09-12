// Package settingsapp exposes the repository's embedded assets so the server
// binary can ship its own migrations and apply them at boot.
package settingsapp

import (
	"embed"
	"io/fs"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// Migrations returns the tern migration set rooted at the migration directory.
func Migrations() fs.FS {
	sub, err := fs.Sub(migrationFiles, "migrations")
	if err != nil {
		// Impossible: the path is a compile-time constant that embed verified.
		panic(err)
	}
	return sub
}
