package valuetype

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"unicode/utf8"
)

// Validate checks a value against a setting's type and rules, returning it in
// canonical form ready to be stored as JSONB. Callers should persist the
// returned bytes rather than the caller's original, so that stored values are
// directly comparable.
func Validate(kind Kind, cfg Config, raw json.RawMessage) (json.RawMessage, error) {
	if !json.Valid(raw) {
		return nil, fmt.Errorf("value is not valid JSON")
	}

	if kind == JSON {
		// JSON is the "any" type: anything that parses is acceptable.
		return compactJSON(raw)
	}

	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("a %s value cannot be null; delete the value instead of setting it to null", kind)
	}

	if kind == Select {
		return validateSelect(cfg, raw)
	}
	return validateScalar(kind, cfg, raw)
}

// validateScalar handles every type except SELECT and JSON.
func validateScalar(kind Kind, cfg Config, raw json.RawMessage) (json.RawMessage, error) {
	switch kind {
	case Boolean:
		var value bool
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, fmt.Errorf("value must be true or false")
		}
		return json.Marshal(value)

	case Number:
		return validateNumber(cfg, raw)

	case String:
		return validateString(cfg, raw)

	case DateTime:
		return normaliseDateTime(raw)

	default:
		return nil, fmt.Errorf("unknown setting type %q", kind)
	}
}

// validateNumber checks bounds without losing the caller's precision: the
// original token is preserved once it is known to be in range.
func validateNumber(cfg Config, raw json.RawMessage) (json.RawMessage, error) {
	var number json.Number
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&number); err != nil {
		return nil, fmt.Errorf("value must be a number")
	}

	value, err := number.Float64()
	if err != nil {
		return nil, fmt.Errorf("%q is not a representable number", number.String())
	}
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return nil, fmt.Errorf("value must be a finite number")
	}

	if cfg.Integer {
		if _, err := strconv.ParseInt(number.String(), 10, 64); err != nil {
			return nil, fmt.Errorf("value must be a whole number, got %s", number.String())
		}
	}
	if cfg.Min != nil && value < *cfg.Min {
		return nil, fmt.Errorf("value %s is below the minimum of %v", number.String(), *cfg.Min)
	}
	if cfg.Max != nil && value > *cfg.Max {
		return nil, fmt.Errorf("value %s is above the maximum of %v", number.String(), *cfg.Max)
	}

	return json.RawMessage(number.String()), nil
}

// validateString applies length and pattern rules. Lengths count runes, not
// bytes, so a limit means the same thing in every alphabet.
func validateString(cfg Config, raw json.RawMessage) (json.RawMessage, error) {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, fmt.Errorf("value must be a string")
	}

	length := utf8.RuneCountInString(value)
	if cfg.MinLength != nil && length < *cfg.MinLength {
		return nil, fmt.Errorf("value is %d characters, shorter than the minimum of %d", length, *cfg.MinLength)
	}
	if cfg.MaxLength != nil && length > *cfg.MaxLength {
		return nil, fmt.Errorf("value is %d characters, longer than the maximum of %d", length, *cfg.MaxLength)
	}

	pattern, err := cfg.compiledPattern()
	if err != nil {
		return nil, err
	}
	if pattern != nil && !pattern.MatchString(value) {
		return nil, fmt.Errorf("value %q does not match the required pattern %s", value, cfg.Pattern)
	}

	return json.Marshal(value)
}

// validateSelect requires the value to be one of the declared options, or an
// array of them when the SELECT is multiple.
func validateSelect(cfg Config, raw json.RawMessage) (json.RawMessage, error) {
	if !cfg.Multiple {
		return matchOption(cfg, raw)
	}

	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		return nil, fmt.Errorf("a multiple SELECT takes an array of option values")
	}

	chosen := make([]json.RawMessage, 0, len(elements))
	for _, element := range elements {
		value, err := matchOption(cfg, element)
		if err != nil {
			return nil, err
		}
		for _, earlier := range chosen {
			if valuesEqual(cfg.Type, earlier, value) {
				return nil, fmt.Errorf("value %s is selected more than once", value)
			}
		}
		chosen = append(chosen, value)
	}
	return json.Marshal(chosen)
}

// matchOption normalises one value and confirms it is a declared option.
func matchOption(cfg Config, raw json.RawMessage) (json.RawMessage, error) {
	inner := cfg
	inner.Type, inner.Options, inner.Multiple = "", nil, false

	value, err := validateScalar(cfg.Type, inner, raw)
	if err != nil {
		return nil, err
	}
	for _, option := range cfg.Options {
		if valuesEqual(cfg.Type, option.Value, value) {
			return option.Value, nil
		}
	}
	return nil, fmt.Errorf("value %s is not one of the available options (%s)", value, optionSummary(cfg.Options))
}

// valuesEqual compares two already-normalised values of the same kind.
// Numbers compare numerically so that 1 and 1.0 are the same option.
func valuesEqual(kind Kind, a, b json.RawMessage) bool {
	if kind == Number {
		left, leftErr := strconv.ParseFloat(string(a), 64)
		right, rightErr := strconv.ParseFloat(string(b), 64)
		if leftErr == nil && rightErr == nil {
			return left == right
		}
	}
	return bytes.Equal(a, b)
}

// optionSummary renders the option values for an error message.
func optionSummary(options []Option) string {
	var buffer bytes.Buffer
	for i, option := range options {
		if i > 0 {
			buffer.WriteString(", ")
		}
		if i == 6 {
			fmt.Fprintf(&buffer, "and %d more", len(options)-i)
			break
		}
		buffer.Write(option.Value)
	}
	return buffer.String()
}

// compactJSON strips insignificant whitespace so stored values are comparable.
func compactJSON(raw json.RawMessage) (json.RawMessage, error) {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, raw); err != nil {
		return nil, fmt.Errorf("value is not valid JSON: %w", err)
	}
	return buffer.Bytes(), nil
}
