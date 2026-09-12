package apikey

import (
	"fmt"
	"slices"
	"strings"
)

// Scope names one capability a key may be granted.
type Scope string

const (
	// ScopeWildcard grants every scope, present and future.
	ScopeWildcard Scope = "*"

	// Key management. The bootstrap key holds exactly these two, which is what
	// makes it CLI-only: it can mint real keys and nothing else.
	ScopeKeysRead  Scope = "keys:read"
	ScopeKeysWrite Scope = "keys:write"

	// Roles, platforms and environments.
	ScopeTaxonomyRead  Scope = "taxonomy:read"
	ScopeTaxonomyWrite Scope = "taxonomy:write"

	// Setting definitions.
	ScopeSettingsRead  Scope = "settings:read"
	ScopeSettingsWrite Scope = "settings:write"

	// Values in the personal, intermediate and server layers.
	ScopeValuesRead  Scope = "values:read"
	ScopeValuesWrite Scope = "values:write"

	// Groups and their membership.
	ScopeGroupsRead  Scope = "groups:read"
	ScopeGroupsWrite Scope = "groups:write"

	// Reading effective settings. This is the scope a product backend needs.
	ScopeResolve Scope = "resolve"
)

// AllScopes is every grantable scope, in the order help output should list them.
var AllScopes = []Scope{
	ScopeResolve,
	ScopeSettingsRead, ScopeSettingsWrite,
	ScopeValuesRead, ScopeValuesWrite,
	ScopeGroupsRead, ScopeGroupsWrite,
	ScopeTaxonomyRead, ScopeTaxonomyWrite,
	ScopeKeysRead, ScopeKeysWrite,
}

// BootstrapScopes are the only scopes the first-boot key ever holds.
var BootstrapScopes = []Scope{ScopeKeysRead, ScopeKeysWrite}

// ParseScopes validates scope names and removes duplicates.
func ParseScopes(names []string) ([]Scope, error) {
	scopes := make([]Scope, 0, len(names))
	for _, name := range names {
		scope := Scope(strings.TrimSpace(name))
		if scope == "" {
			continue
		}
		if scope != ScopeWildcard && !slices.Contains(AllScopes, scope) {
			return nil, fmt.Errorf("unknown scope %q (available: %s)", scope, JoinScopes(AllScopes))
		}
		if !slices.Contains(scopes, scope) {
			scopes = append(scopes, scope)
		}
	}
	if len(scopes) == 0 {
		return nil, fmt.Errorf("a key needs at least one scope (available: %s, or * for all)", JoinScopes(AllScopes))
	}
	return scopes, nil
}

// Grants reports whether a set of granted scopes satisfies a required one.
func Grants(granted []string, required Scope) bool {
	for _, scope := range granted {
		if Scope(scope) == ScopeWildcard || Scope(scope) == required {
			return true
		}
	}
	return false
}

// Strings converts scopes for storage.
func Strings(scopes []Scope) []string {
	out := make([]string, len(scopes))
	for i, scope := range scopes {
		out[i] = string(scope)
	}
	return out
}

// JoinScopes renders a scope list for help text and error messages.
func JoinScopes(scopes []Scope) string {
	return strings.Join(Strings(scopes), ", ")
}
