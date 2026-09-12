//go:build integration

package api_test

import (
	"net/http"
	"testing"
)

// production is the environment every test in this file works in.
const production = "production"

// personalBoolean defines a per-user boolean setting.
func personalBoolean(name string, defaultValue any) map[string]any {
	return map[string]any{
		"name": name, "type": "BOOLEAN", "role": "user", "scope": "PERSONAL",
		"platform": "web", "environment": production, "default_value": defaultValue,
	}
}

// TestResolutionPrecedence walks the whole layering model from the README:
// a default, a server value, an advisory group override, the user's own
// choice, and an enforced group override that displaces it.
func TestResolutionPrecedence(t *testing.T) {
	h := newHarness(t)

	setting := h.createSetting(personalBoolean("dark_mode", false))
	group := h.createGroup("beta", production, 10, []string{"alice"})

	settingPath := "/api/v1/settings/" + setting

	t.Run("falls back to the declared default", func(t *testing.T) {
		got := h.resolveUser(h.adminKey, "alice", "environment="+production)["dark_mode"]
		assertValue(t, got, "false", "DEFAULT")
		if got.Override != nil {
			t.Errorf("unexpected override: %+v", got.Override)
		}
	})

	t.Run("a server value beats the default", func(t *testing.T) {
		h.mustAdmin(http.MethodPut, settingPath+"/server", value(true), http.StatusOK)
		assertValue(t, h.resolveUser(h.adminKey, "alice", "environment="+production)["dark_mode"],
			"true", "SERVER")
	})

	t.Run("an advisory group override beats the server value", func(t *testing.T) {
		h.mustAdmin(http.MethodPut, settingPath+"/intermediate/"+group,
			map[string]any{"value": false, "enforced": false}, http.StatusOK)

		got := h.resolveUser(h.adminKey, "alice", "environment="+production)["dark_mode"]
		assertValue(t, got, "false", "INTERMEDIATE")
		if got.Override == nil || got.Override.Enforced {
			t.Fatalf("expected an advisory override, got %+v", got.Override)
		}
	})

	t.Run("the user's own value beats an advisory override", func(t *testing.T) {
		h.mustAdmin(http.MethodPut, settingPath+"/personal/alice", value(true), http.StatusOK)

		got := h.resolveUser(h.adminKey, "alice", "environment="+production)["dark_mode"]
		assertValue(t, got, "true", "PERSONAL")
		if got.Override != nil {
			t.Errorf("an advisory override must yield to the user's value, got %+v", got.Override)
		}
	})

	t.Run("an enforced override beats the user's own value", func(t *testing.T) {
		h.mustAdmin(http.MethodPut, settingPath+"/intermediate/"+group,
			map[string]any{"value": false, "enforced": true, "visible": false}, http.StatusOK)

		got := h.resolveUser(h.adminKey, "alice", "environment="+production)["dark_mode"]
		assertValue(t, got, "false", "INTERMEDIATE")

		if got.Override == nil {
			t.Fatal("expected an override")
		}
		if !got.Override.Enforced {
			t.Error("override should be enforced")
		}
		if got.Override.Visible {
			t.Error("override was declared invisible")
		}
		// The displaced value comes back so a caller can restore it later.
		if string(got.Override.ReplacedValue) != "true" {
			t.Errorf("replaced_value = %s, want true", got.Override.ReplacedValue)
		}
	})

	t.Run("a user outside the group is unaffected", func(t *testing.T) {
		got := h.resolveUser(h.adminKey, "carol", "environment="+production)["dark_mode"]
		assertValue(t, got, "true", "SERVER")
		if got.Override != nil {
			t.Errorf("carol is in no group, got %+v", got.Override)
		}
	})
}

// TestGroupPriorityBreaksTies checks that the highest-priority group wins when
// a user belongs to two groups overriding the same setting.
func TestGroupPriorityBreaksTies(t *testing.T) {
	h := newHarness(t)

	setting := h.createSetting(personalBoolean("beta_banner", false))
	low := h.createGroup("low", production, 1, []string{"alice"})
	high := h.createGroup("high", production, 99, []string{"alice"})

	path := "/api/v1/settings/" + setting + "/intermediate/"
	h.mustAdmin(http.MethodPut, path+low, map[string]any{"value": false}, http.StatusOK)
	h.mustAdmin(http.MethodPut, path+high, map[string]any{"value": true}, http.StatusOK)

	got := h.resolveUser(h.adminKey, "alice", "environment="+production)["beta_banner"]
	assertValue(t, got, "true", "INTERMEDIATE")
	if got.Override == nil || got.Override.GroupID != high {
		t.Errorf("expected the higher-priority group to win, got %+v", got.Override)
	}
}

// TestAdHocGroupApplies checks that a group can be applied to a user who is
// not a saved member of it, which is how ad-hoc groups are used.
func TestAdHocGroupApplies(t *testing.T) {
	h := newHarness(t)

	setting := h.createSetting(personalBoolean("new_nav", false))
	group := h.createGroup("adhoc", production, 5, nil)
	h.mustAdmin(http.MethodPut, "/api/v1/settings/"+setting+"/intermediate/"+group,
		map[string]any{"value": true}, http.StatusOK)

	// Not a member: the override must not apply.
	got := h.resolveUser(h.adminKey, "dave", "environment="+production)["new_nav"]
	assertValue(t, got, "false", "DEFAULT")

	// Named explicitly on the request: it applies, without storing membership.
	got = h.resolveUser(h.adminKey, "dave", "environment="+production+"&group_id="+group)["new_nav"]
	assertValue(t, got, "true", "INTERMEDIATE")
}

// TestScopeLimitsLayers checks the guard that stops a value being written to a
// layer the setting's scope forbids.
func TestScopeLimitsLayers(t *testing.T) {
	h := newHarness(t)

	serverScoped := h.createSetting(map[string]any{
		"name": "uploads_enabled", "type": "BOOLEAN", "role": "user", "scope": "SERVER",
		"platform": "web", "environment": production, "default_value": true,
	})

	result := h.admin(http.MethodPut, "/api/v1/settings/"+serverScoped+"/personal/alice", value(false))
	if result.status != http.StatusBadRequest {
		t.Fatalf("writing a personal value to a SERVER setting = %d, want 400: %s", result.status, result.body)
	}
	if message := result.errorMessage(t); message == "" {
		t.Error("expected an explanatory message")
	}

	// A SERVER-scoped setting still appears in a user's resolution: a client
	// needs it to know which features are switched on.
	if _, present := h.resolveUser(h.adminKey, "alice", "environment="+production)["uploads_enabled"]; !present {
		t.Error("a SERVER setting should be visible when resolving a user")
	}
}

// value builds a value request body.
func value(v any) map[string]any { return map[string]any{"value": v} }

// assertValue checks a resolved setting's value and source.
func assertValue(t *testing.T, got resolved, wantValue, wantSource string) {
	t.Helper()
	if string(got.Value) != wantValue {
		t.Errorf("value = %s, want %s", got.Value, wantValue)
	}
	if got.Source != wantSource {
		t.Errorf("source = %s, want %s", got.Source, wantSource)
	}
}

// createGroup makes a group and returns its id.
func (h *harness) createGroup(name, environment string, priority int, members []string) string {
	h.t.Helper()

	body := map[string]any{"name": name, "environment": environment, "priority": priority}
	if members != nil {
		body["members"] = members
	}

	result := h.mustAdmin(http.MethodPost, "/api/v1/groups", body, http.StatusCreated)
	var created struct {
		ID string `json:"id"`
	}
	result.decode(h.t, &created)
	return created.ID
}
