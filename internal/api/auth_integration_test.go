//go:build integration

package api_test

import (
	"net/http"
	"testing"

	"github.com/connordoman/app-settings/internal/apikey"
)

// TestBootstrapKeyIsCLIOnly checks the key minted at first boot can mint other
// keys and do nothing else.
func TestBootstrapKeyIsCLIOnly(t *testing.T) {
	h := newHarness(t)

	bootstrap := h.bootstrapKey

	// It can list and create keys.
	if result := h.do(bootstrap, http.MethodGet, "/api/v1/keys", nil); result.status != http.StatusOK {
		t.Errorf("listing keys = %d, want 200: %s", result.status, result.body)
	}
	minted := h.do(bootstrap, http.MethodPost, "/api/v1/keys", map[string]any{
		"name": "minted by bootstrap", "scopes": []string{"resolve"}, "role": "user",
	})
	if minted.status != http.StatusCreated {
		t.Fatalf("creating a key = %d, want 201: %s", minted.status, minted.body)
	}

	// It can do nothing else.
	for _, call := range []struct {
		method, path string
	}{
		{http.MethodGet, "/api/v1/settings?environment=" + production},
		{http.MethodGet, "/api/v1/groups"},
		{http.MethodGet, "/api/v1/roles"},
		{http.MethodGet, "/api/v1/resolve/user/alice?environment=" + production},
	} {
		result := h.do(bootstrap, call.method, call.path, nil)
		if result.status != http.StatusForbidden {
			t.Errorf("%s %s = %d, want 403: %s", call.method, call.path, result.status, result.body)
		}
	}

	// And only one may ever exist.
	second, err := h.store.EnsureBootstrapKey(t.Context())
	if err != nil {
		t.Fatalf("second EnsureBootstrapKey: %v", err)
	}
	if second != nil {
		t.Error("a second bootstrap key was minted")
	}
}

// TestEnvironmentFencing checks that a key restricted to one environment
// cannot read or write another, which is what stops cross-pollination.
func TestEnvironmentFencing(t *testing.T) {
	h := newHarness(t)

	h.createSetting(personalBoolean("dark_mode", false))
	staging := h.mintKey("staging only",
		[]apikey.Scope{apikey.ScopeWildcard}, "admin", []string{"staging"}, nil)

	t.Run("cannot resolve another environment", func(t *testing.T) {
		result := h.do(staging, http.MethodGet, "/api/v1/resolve/user/alice?environment="+production, nil)
		if result.status != http.StatusForbidden {
			t.Fatalf("= %d, want 403: %s", result.status, result.body)
		}
	})

	t.Run("does not see another environment's settings in a listing", func(t *testing.T) {
		result := h.do(staging, http.MethodGet, "/api/v1/settings", nil)
		if result.status != http.StatusOK {
			t.Fatalf("= %d, want 200: %s", result.status, result.body)
		}
		var body struct {
			Settings []resolved `json:"settings"`
		}
		result.decode(t, &body)
		if len(body.Settings) != 0 {
			t.Errorf("a staging key saw %d production settings", len(body.Settings))
		}
	})

	t.Run("cannot mint a key that reaches further than itself", func(t *testing.T) {
		result := h.do(staging, http.MethodPost, "/api/v1/keys", map[string]any{
			"name": "escalated", "scopes": []string{"resolve"},
			"environments": []string{production}, "role": "admin",
		})
		if result.status != http.StatusBadRequest {
			t.Fatalf("= %d, want 400: %s", result.status, result.body)
		}
	})
}

// TestRoleCeiling checks that a key cannot see or mint above its own rank.
func TestRoleCeiling(t *testing.T) {
	h := newHarness(t)

	h.createSetting(personalBoolean("dark_mode", false))
	h.createSetting(map[string]any{
		"name": "audit_level", "type": "STRING", "role": "admin", "scope": "SERVER",
		"platform": "web", "environment": production, "default_value": "verbose",
	})

	userKey := h.mintKey("frontend", []apikey.Scope{apikey.ScopeResolve}, "user", nil, nil)

	settings := h.resolveUser(userKey, "alice", "environment="+production)
	if _, visible := settings["audit_level"]; visible {
		t.Error("a user-role key saw an admin-only setting")
	}
	if _, visible := settings["dark_mode"]; !visible {
		t.Error("a user-role key should see a user-role setting")
	}

	// It cannot simply ask to resolve as a higher role.
	result := h.do(userKey, http.MethodGet,
		"/api/v1/resolve/user/alice?environment="+production+"&role=admin", nil)
	if result.status != http.StatusForbidden {
		t.Errorf("resolving as admin = %d, want 403: %s", result.status, result.body)
	}
}

// TestRejectedCredentials covers the ways a key can fail to authenticate.
func TestRejectedCredentials(t *testing.T) {
	h := newHarness(t)

	valid := h.mintKey("revocable", []apikey.Scope{apikey.ScopeResolve}, "user", nil, nil)

	t.Run("garbage token", func(t *testing.T) {
		if result := h.do("not-a-key", http.MethodGet, "/api/v1/whoami", nil); result.status != http.StatusUnauthorized {
			t.Errorf("= %d, want 401", result.status)
		}
	})

	t.Run("well-formed but unknown token", func(t *testing.T) {
		unknown, err := apikey.Generate()
		if err != nil {
			t.Fatal(err)
		}
		if result := h.do(unknown.String(), http.MethodGet, "/api/v1/whoami", nil); result.status != http.StatusUnauthorized {
			t.Errorf("= %d, want 401", result.status)
		}
	})

	t.Run("correct prefix with the wrong secret", func(t *testing.T) {
		other, err := apikey.Generate()
		if err != nil {
			t.Fatal(err)
		}
		prefix, err := apikey.Parse(valid)
		if err != nil {
			t.Fatal(err)
		}
		forged := apikey.Label + "_" + prefix + "_" + other.Secret

		if result := h.do(forged, http.MethodGet, "/api/v1/whoami", nil); result.status != http.StatusUnauthorized {
			t.Errorf("a forged secret on a real prefix = %d, want 401", result.status)
		}
	})

	t.Run("missing credentials", func(t *testing.T) {
		if result := h.do("", http.MethodGet, "/api/v1/whoami", nil); result.status != http.StatusUnauthorized {
			t.Errorf("= %d, want 401", result.status)
		}
	})

	t.Run("revoked key stops working immediately", func(t *testing.T) {
		var identity struct {
			KeyID string `json:"key_id"`
		}
		h.do(valid, http.MethodGet, "/api/v1/whoami", nil).decode(t, &identity)

		h.mustAdmin(http.MethodDelete, "/api/v1/keys/"+identity.KeyID, nil, http.StatusNoContent)

		if result := h.do(valid, http.MethodGet, "/api/v1/whoami", nil); result.status != http.StatusUnauthorized {
			t.Errorf("a revoked key = %d, want 401: %s", result.status, result.body)
		}
	})
}
