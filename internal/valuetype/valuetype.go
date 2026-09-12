// Package valuetype defines the setting types from the README and validates
// values against them. Every value is ultimately stored as JSONB, so this
// package is the only thing standing between a caller and a nonsense value.
package valuetype

import (
	"encoding/json"
	"fmt"

	"github.com/connordoman/settings-app/internal/database"
)

// Kind aliases the generated enum so callers can use either interchangeably.
type Kind = database.SettingType

const (
	Boolean  = database.SettingTypeBOOLEAN
	Number   = database.SettingTypeNUMBER
	String   = database.SettingTypeSTRING
	DateTime = database.SettingTypeDATETIME
	Select   = database.SettingTypeSELECT
	JSON     = database.SettingTypeJSON
)

// Kinds lists every valid setting type.
var Kinds = []Kind{Boolean, Number, String, DateTime, Select, JSON}

// ValidKind reports whether k is a known setting type.
func ValidKind(k Kind) bool {
	for _, known := range Kinds {
		if k == known {
			return true
		}
	}
	return false
}

// scalarKinds are the types a SELECT may draw its options from.
var scalarKinds = []Kind{Boolean, Number, String, DateTime}

// Option is one choice of a SELECT. The README writes options as
// ["Red", "#ff0000"] tuples, so that is the canonical wire form; an
// {"label": ..., "value": ...} object is also accepted on input.
type Option struct {
	Label string          `json:"label"`
	Value json.RawMessage `json:"value"`
}

// MarshalJSON emits the [label, value] tuple form.
func (o Option) MarshalJSON() ([]byte, error) {
	label, err := json.Marshal(o.Label)
	if err != nil {
		return nil, err
	}
	value := o.Value
	if len(value) == 0 {
		value = json.RawMessage("null")
	}
	return json.Marshal([]json.RawMessage{label, value})
}

// UnmarshalJSON accepts either the tuple or the object form.
func (o *Option) UnmarshalJSON(data []byte) error {
	var tuple []json.RawMessage
	if err := json.Unmarshal(data, &tuple); err == nil {
		if len(tuple) != 2 {
			return fmt.Errorf("option tuple must have exactly 2 elements, got %d", len(tuple))
		}
		if err := json.Unmarshal(tuple[0], &o.Label); err != nil {
			return fmt.Errorf("option label must be a string: %w", err)
		}
		o.Value = tuple[1]
		return nil
	}

	var object struct {
		Label string          `json:"label"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(data, &object); err != nil {
		return fmt.Errorf("option must be a [label, value] tuple or a {label, value} object: %w", err)
	}
	o.Label, o.Value = object.Label, object.Value
	return nil
}

// KindNames renders every setting type for help text and error messages.
func KindNames() string {
	return joinKinds(Kinds)
}
