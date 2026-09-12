package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/connordoman/app-settings/internal/apikey"
	"github.com/connordoman/app-settings/internal/database"
)

// BootstrapKeyName identifies the key minted at first boot.
const BootstrapKeyName = "bootstrap (CLI only)"

// EnsureBootstrapKey mints the first API key if the database has none.
//
// It exists to solve the chicken-and-egg problem of a self-hosted server: the
// API requires a key, and minting a key requires the API. The bootstrap key
// holds only the two key-management scopes, so it can create real keys and do
// nothing else with the data.
//
// It returns nil when a key already exists, which is every boot after the
// first. The token is returned in full because this is the only moment it can
// ever be read.
func (s *Store) EnsureBootstrapKey(ctx context.Context) (*apikey.Token, error) {
	count, err := s.CountApiKeys(ctx)
	if err != nil {
		return nil, fmt.Errorf("count existing keys: %w", err)
	}
	if count > 0 {
		return nil, nil
	}

	role, err := s.highestRole(ctx)
	if err != nil {
		return nil, err
	}

	token, err := apikey.Generate()
	if err != nil {
		return nil, err
	}

	_, err = s.CreateApiKey(ctx, database.CreateApiKeyParams{
		Name:        BootstrapKeyName,
		Prefix:      token.Prefix,
		SecretHash:  token.Hash(),
		Scopes:      apikey.Strings(apikey.BootstrapScopes),
		Role:        role,
		IsBootstrap: true,
		// No environment or platform filter: the keys it mints are narrowed
		// individually, and a bootstrap key that could not reach an
		// environment could not create a key for it either.
		Environments: []string{},
		Platforms:    []string{},
		Actor:        "bootstrap",
	})
	if err != nil {
		// Another instance booting at the same moment won the race. The
		// partial unique index on is_bootstrap guarantees only one exists.
		if errors.Is(Classify(err), ErrConflict) {
			return nil, nil
		}
		return nil, fmt.Errorf("create bootstrap key: %w", err)
	}

	return &token, nil
}

// highestRole returns the most privileged role, which the bootstrap key needs
// so that it can mint keys at any rank.
func (s *Store) highestRole(ctx context.Context) (string, error) {
	roles, err := s.ListRoles(ctx)
	if err != nil {
		return "", fmt.Errorf("list roles: %w", err)
	}
	if len(roles) == 0 {
		return "", fmt.Errorf("no roles are defined; migrations seed `user`, `staff` and `admin`")
	}
	// ListRoles orders by rank ascending.
	return roles[len(roles)-1].Name, nil
}
