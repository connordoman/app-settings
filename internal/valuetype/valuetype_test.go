package valuetype_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/connordoman/settings-app/internal/valuetype"
)

// configJSON builds a Config from its wire form, failing the test if the
// definition is not one the server would accept.
func configJSON(t *testing.T, kind valuetype.Kind, raw string) valuetype.Config {
	t.Helper()
	cfg, err := valuetype.ParseConfig(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("ParseConfig(%s): %v", raw, err)
	}
	cfg, err = valuetype.ValidateConfig(kind, cfg)
	if err != nil {
		t.Fatalf("ValidateConfig(%s, %s): %v", kind, raw, err)
	}
	return cfg
}

func TestValidateDateTime(t *testing.T) {
	cfg := configJSON(t, valuetype.DateTime, `{}`)

	tests := []struct {
		name  string
		value string
		want  string // empty means the value must be rejected
	}{
		// The offset is what makes a value an instant, so it is required, and
		// everything is normalised to UTC.
		{"utc passes through", `"2026-01-02T15:04:05Z"`, `"2026-01-02T15:04:05Z"`},
		{"offset is converted to utc", `"2026-01-02T15:04:05-05:00"`, `"2026-01-02T20:04:05Z"`},
		{"eastern offset", `"2026-01-02T15:04:05+05:30"`, `"2026-01-02T09:34:05Z"`},

		// Date.prototype.toISOString() output, which is what a browser sends
		// when a Date goes through JSON.stringify.
		{"javascript toISOString", `"2026-01-02T20:04:05.250Z"`, `"2026-01-02T20:04:05.25Z"`},
		{"millisecond precision is kept", `"2026-01-02T20:04:05.123Z"`, `"2026-01-02T20:04:05.123Z"`},
		{"sub-millisecond precision is kept", `"2026-01-02T20:04:05.123456789Z"`, `"2026-01-02T20:04:05.123456789Z"`},
		{"a zero fraction is dropped", `"2026-01-02T20:04:05.000Z"`, `"2026-01-02T20:04:05Z"`},

		// RFC 3339 §5.6 permits lower case; canonical output is upper.
		{"lower-case designators", `"2026-01-02t15:04:05z"`, `"2026-01-02T15:04:05Z"`},

		// RFC 3339 §4.3 uses -00:00 for "offset unknown". Normalising to UTC
		// necessarily renders it as Z.
		{"unknown offset becomes utc", `"2026-01-02T15:04:05-00:00"`, `"2026-01-02T15:04:05Z"`},

		// Rejections: each is a shape a client actually sends.
		{"no offset", `"2026-01-02T15:04:05"`, ``},
		{"datetime-local input", `"2026-01-02T15:04"`, ``},
		{"date only", `"2026-01-02"`, ``},
		{"time only", `"15:04:05Z"`, ``},
		{"compact offset", `"2026-01-02T15:04:05-0500"`, ``},
		{"hour-only offset", `"2026-01-02T15:04:05-05"`, ``},
		{"space separator", `"2026-01-02 15:04:05Z"`, ``},
		{"no seconds", `"2026-01-02T15:04Z"`, ``},
		{"impossible month", `"2026-13-02T15:04:05Z"`, ``},
		{"leap second", `"2026-01-02T23:59:60Z"`, ``},
		{"not a string", `1767380645`, ``},
		{"empty", `""`, ``},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := valuetype.Validate(valuetype.DateTime, cfg, json.RawMessage(test.value))

			if test.want == "" {
				if err == nil {
					t.Fatalf("expected %s to be rejected, got %s", test.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Validate(%s): %v", test.value, err)
			}
			if string(got) != test.want {
				t.Errorf("Validate(%s) = %s, want %s", test.value, got, test.want)
			}
		})
	}
}

// TestDateTimeEqualInstantsAreIdentical checks the point of normalising to
// UTC: the same moment written in different zones is stored identically, so
// values can be compared and sorted as plain strings.
func TestDateTimeEqualInstantsAreIdentical(t *testing.T) {
	cfg := configJSON(t, valuetype.DateTime, `{}`)

	sameMoment := []string{
		`"2026-01-02T20:04:05Z"`,
		`"2026-01-02T15:04:05-05:00"`,
		`"2026-01-03T05:04:05+09:00"`,
	}

	var first string
	for i, value := range sameMoment {
		got, err := valuetype.Validate(valuetype.DateTime, cfg, json.RawMessage(value))
		if err != nil {
			t.Fatalf("Validate(%s): %v", value, err)
		}
		if i == 0 {
			first = string(got)
			continue
		}
		if string(got) != first {
			t.Errorf("Validate(%s) = %s, want %s (the same instant)", value, got, first)
		}
	}
}

// TestDateTimeErrorsArePractical checks that the common client mistakes are
// each named, rather than all producing one generic parse error.
func TestDateTimeErrorsArePractical(t *testing.T) {
	cfg := configJSON(t, valuetype.DateTime, `{}`)

	tests := []struct{ name, value, wantSubstring string }{
		{"datetime-local", `"2026-01-02T15:04"`, "has no UTC offset"},
		{"no offset", `"2026-01-02T15:04:05"`, "has no UTC offset"},
		{"date only", `"2026-01-02"`, "has no UTC offset"},
		{"compact offset", `"2026-01-02T15:04:05-0500"`, "malformed UTC offset"},
		{"space separator", `"2026-01-02 15:04:05Z"`, `separate the date and time with "T"`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := valuetype.Validate(valuetype.DateTime, cfg, json.RawMessage(test.value))
			if err == nil {
				t.Fatalf("expected %s to be rejected", test.value)
			}
			if !strings.Contains(err.Error(), test.wantSubstring) {
				t.Errorf("error %q does not mention %q", err, test.wantSubstring)
			}
		})
	}
}

func TestValidateSelect(t *testing.T) {
	// The exact shape the README gives for SELECT.
	cfg := configJSON(t, valuetype.Select,
		`{"type":"STRING","options":[["Red","#ff0000"],["Green","#00ff00"],["Blue","#0000ff"]]}`)

	got, err := valuetype.Validate(valuetype.Select, cfg, json.RawMessage(`"#00ff00"`))
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if string(got) != `"#00ff00"` {
		t.Errorf("got %s, want \"#00ff00\"", got)
	}

	if _, err := valuetype.Validate(valuetype.Select, cfg, json.RawMessage(`"#123456"`)); err == nil {
		t.Error("expected a value outside the option list to be rejected")
	}

	// Options round-trip back to the README's tuple form.
	encoded, err := json.Marshal(cfg.Options[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `["Red","#ff0000"]` {
		t.Errorf("option encoded as %s, want [\"Red\",\"#ff0000\"]", encoded)
	}
}

func TestValidateScalars(t *testing.T) {
	tests := []struct {
		name   string
		kind   valuetype.Kind
		config string
		value  string
		want   string
	}{
		{"boolean", valuetype.Boolean, `{}`, `true`, `true`},
		{"boolean rejects string", valuetype.Boolean, `{}`, `"true"`, ``},
		{"number keeps precision", valuetype.Number, `{}`, `1.50`, `1.50`},
		{"number honours min", valuetype.Number, `{"min":0}`, `-1`, ``},
		{"number integer only", valuetype.Number, `{"integer":true}`, `1.5`, ``},
		{"string pattern", valuetype.String, `{"pattern":"[a-z-]+"}`, `"my-date-filter"`, `"my-date-filter"`},
		{"string pattern is anchored", valuetype.String, `{"pattern":"[a-z-]+"}`, `"NOPE-nope"`, ``},
		{"string max length", valuetype.String, `{"max_length":3}`, `"hello"`, ``},
		{"json takes anything", valuetype.JSON, `{}`, `{"a": [1, 2]}`, `{"a":[1,2]}`},
		{"null is rejected", valuetype.String, `{}`, `null`, ``},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := configJSON(t, test.kind, test.config)
			got, err := valuetype.Validate(test.kind, cfg, json.RawMessage(test.value))

			if test.want == "" {
				if err == nil {
					t.Fatalf("expected %s to be rejected, got %s", test.value, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("Validate(%s): %v", test.value, err)
			}
			if string(got) != test.want {
				t.Errorf("Validate(%s) = %s, want %s", test.value, got, test.want)
			}
		})
	}
}
