package valuetype

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Config holds the type-specific rules attached to a setting definition. It is
// persisted as settings.type_config. Every field is optional; only the ones
// relevant to the setting's type are consulted.
type Config struct {
	// SELECT. Type names the scalar the options are drawn from, matching the
	// README's {type: "STRING", options: [["Red", "#ff0000"]]} shape.
	Type     Kind     `json:"type,omitempty"`
	Options  []Option `json:"options,omitempty"`
	Multiple bool     `json:"multiple,omitempty"`

	// NUMBER.
	Min     *float64 `json:"min,omitempty"`
	Max     *float64 `json:"max,omitempty"`
	Integer bool     `json:"integer,omitempty"`

	// STRING. Pattern is RE2 syntax and must match the whole value.
	MinLength *int   `json:"min_length,omitempty"`
	MaxLength *int   `json:"max_length,omitempty"`
	Pattern   string `json:"pattern,omitempty"`
}

// compiledPattern returns the STRING pattern anchored to the whole value.
func (c Config) compiledPattern() (*regexp.Regexp, error) {
	if c.Pattern == "" {
		return nil, nil
	}
	expression := c.Pattern
	if !strings.HasPrefix(expression, "^") {
		expression = "^" + expression
	}
	if !strings.HasSuffix(expression, "$") {
		expression += "$"
	}
	compiled, err := regexp.Compile(expression)
	if err != nil {
		return nil, fmt.Errorf("pattern %q is not valid RE2 syntax: %w", c.Pattern, err)
	}
	return compiled, nil
}

// ParseConfig decodes a stored type_config document.
func ParseConfig(raw json.RawMessage) (Config, error) {
	var cfg Config
	if len(raw) == 0 {
		return cfg, nil
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, fmt.Errorf("type_config is not a valid configuration object: %w", err)
	}
	return cfg, nil
}

// ValidateConfig checks that a config makes sense for kind and returns it with
// SELECT option values normalised. Reject bad definitions here so that no
// value ever has to be validated against an incoherent rule.
func ValidateConfig(kind Kind, cfg Config) (Config, error) {
	if !ValidKind(kind) {
		return cfg, fmt.Errorf("unknown setting type %q", kind)
	}

	switch kind {
	case Select:
		return validateSelectConfig(cfg)

	case Number:
		if cfg.Min != nil && cfg.Max != nil && *cfg.Min > *cfg.Max {
			return cfg, fmt.Errorf("min %v is greater than max %v", *cfg.Min, *cfg.Max)
		}

	case String:
		if cfg.MinLength != nil && *cfg.MinLength < 0 {
			return cfg, fmt.Errorf("min_length cannot be negative")
		}
		if cfg.MinLength != nil && cfg.MaxLength != nil && *cfg.MinLength > *cfg.MaxLength {
			return cfg, fmt.Errorf("min_length %d is greater than max_length %d", *cfg.MinLength, *cfg.MaxLength)
		}
		if _, err := cfg.compiledPattern(); err != nil {
			return cfg, err
		}
	}

	return cfg, nil
}

// validateSelectConfig checks the option list and normalises each option value
// against the SELECT's underlying scalar type.
func validateSelectConfig(cfg Config) (Config, error) {
	if cfg.Type == "" {
		return cfg, fmt.Errorf("a SELECT must declare the type of its options, for example {\"type\": \"STRING\"}")
	}
	if !isScalarKind(cfg.Type) {
		return cfg, fmt.Errorf("a SELECT cannot draw options from %s (allowed: %s)", cfg.Type, joinKinds(scalarKinds))
	}
	if len(cfg.Options) == 0 {
		return cfg, fmt.Errorf("a SELECT must declare at least one option")
	}

	// The option type carries its own rules, so validate the inner config too.
	inner := cfg
	inner.Type, inner.Options, inner.Multiple = "", nil, false
	inner, err := ValidateConfig(cfg.Type, inner)
	if err != nil {
		return cfg, fmt.Errorf("SELECT option rules: %w", err)
	}

	labels := make(map[string]struct{}, len(cfg.Options))
	normalised := make([]Option, 0, len(cfg.Options))
	for i, option := range cfg.Options {
		if option.Label == "" {
			return cfg, fmt.Errorf("option %d has an empty label", i)
		}
		if _, duplicate := labels[option.Label]; duplicate {
			return cfg, fmt.Errorf("option label %q appears more than once", option.Label)
		}
		labels[option.Label] = struct{}{}

		value, err := validateScalar(cfg.Type, inner, option.Value)
		if err != nil {
			return cfg, fmt.Errorf("option %q: %w", option.Label, err)
		}
		for _, earlier := range normalised {
			if valuesEqual(cfg.Type, earlier.Value, value) {
				return cfg, fmt.Errorf("options %q and %q have the same value", earlier.Label, option.Label)
			}
		}
		normalised = append(normalised, Option{Label: option.Label, Value: value})
	}

	cfg.Options = normalised
	return cfg, nil
}

// isScalarKind reports whether a SELECT may use kind for its options.
func isScalarKind(kind Kind) bool {
	for _, scalar := range scalarKinds {
		if scalar == kind {
			return true
		}
	}
	return false
}

func joinKinds(kinds []Kind) string {
	names := make([]string, len(kinds))
	for i, kind := range kinds {
		names[i] = string(kind)
	}
	return strings.Join(names, ", ")
}
