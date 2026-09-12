//go:build integration

package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

// TestDateTimeEndToEnd checks that a DATETIME survives a round trip through
// the API and the database, normalised to UTC, and that the shapes a client
// commonly sends by mistake are refused.
func TestDateTimeEndToEnd(t *testing.T) {
	h := newHarness(t)

	setting := h.createSetting(map[string]any{
		"name": "trial_ends_at", "type": "DATETIME",
		"role": "user", "scope": "PERSONAL", "platform": "web", "environment": production,
	})
	path := "/api/v1/settings/" + setting + "/personal/alice"

	accepted := []struct{ sent, stored string }{
		{"2026-01-02T15:04:05Z", `"2026-01-02T15:04:05Z"`},
		// Converted to UTC on the way in.
		{"2026-01-02T15:04:05-05:00", `"2026-01-02T20:04:05Z"`},
		// Exactly what Date.prototype.toISOString() emits.
		{"2026-01-02T20:04:05.250Z", `"2026-01-02T20:04:05.25Z"`},
		// RFC 3339 permits lower case; canonical output is upper.
		{"2026-01-02t15:04:05z", `"2026-01-02T15:04:05Z"`},
	}
	for _, test := range accepted {
		t.Run("accepts "+test.sent, func(t *testing.T) {
			h.mustAdmin(http.MethodPut, path, value(test.sent), http.StatusOK)

			var stored struct {
				Value json.RawMessage `json:"value"`
			}
			h.mustAdmin(http.MethodGet, path, nil, http.StatusOK).decode(t, &stored)
			if string(stored.Value) != test.stored {
				t.Errorf("stored %s, want %s", stored.Value, test.stored)
			}
		})
	}

	rejected := []string{
		"2026-01-02T15:04:05",      // no offset, so not an instant
		"2026-01-02T15:04",         // <input type="datetime-local">
		"2026-01-02",               // date alone
		"2026-01-02T15:04:05-0500", // compact offset
		"2026-01-02 15:04:05Z",     // space separator
		"2026-01-02T23:59:60Z",     // leap second, which Go cannot represent
		"yesterday",
	}
	for _, bad := range rejected {
		t.Run("rejects "+bad, func(t *testing.T) {
			result := h.admin(http.MethodPut, path, value(bad))
			if result.status != http.StatusBadRequest {
				t.Fatalf("= %d, want 400: %s", result.status, result.body)
			}
			if message := result.errorMessage(t); message == "" {
				t.Error("expected an explanatory message")
			}
		})
	}
}

// TestLegacyTemporalTypesAreGone checks that DATE and TIME can no longer be
// declared: migration 007 removed them from the setting_type enum.
func TestLegacyTemporalTypesAreGone(t *testing.T) {
	h := newHarness(t)

	for _, kind := range []string{"DATE", "TIME"} {
		result := h.admin(http.MethodPost, "/api/v1/settings", map[string]any{
			"name": "legacy_" + kind, "type": kind,
			"role": "user", "scope": "PERSONAL", "platform": "web", "environment": production,
		})
		if result.status != http.StatusBadRequest {
			t.Errorf("declaring a %s setting = %d, want 400: %s", kind, result.status, result.body)
		}
	}
}

// TestSelectSetting checks the SELECT shape from the README.
func TestSelectSetting(t *testing.T) {
	h := newHarness(t)

	setting := h.createSetting(map[string]any{
		"name": "accent_colour", "type": "SELECT",
		"type_config": map[string]any{
			"type": "STRING",
			"options": [][]string{
				{"Red", "#ff0000"}, {"Green", "#00ff00"}, {"Blue", "#0000ff"},
			},
		},
		"role": "user", "scope": "PERSONAL", "platform": "web", "environment": production,
		"default_value": "#ff0000",
	})
	path := "/api/v1/settings/" + setting + "/personal/alice"

	h.mustAdmin(http.MethodPut, path, value("#00ff00"), http.StatusOK)
	if result := h.admin(http.MethodPut, path, value("#123456")); result.status != http.StatusBadRequest {
		t.Errorf("a value outside the options = %d, want 400: %s", result.status, result.body)
	}

	// Options round-trip in the README's tuple form.
	var definition struct {
		TypeConfig struct {
			Options []json.RawMessage `json:"options"`
		} `json:"type_config"`
	}
	h.mustAdmin(http.MethodGet, "/api/v1/settings/"+setting, nil, http.StatusOK).decode(t, &definition)
	if got := string(definition.TypeConfig.Options[0]); got != `["Red","#ff0000"]` {
		t.Errorf("option encoded as %s, want [\"Red\",\"#ff0000\"]", got)
	}
}

// settingName gives each table-driven case a distinct setting.
func settingName(i int) string {
	return "temporal_" + string(rune('a'+i))
}
