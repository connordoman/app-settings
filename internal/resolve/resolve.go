// Package resolve turns the layered rows returned by the database into the
// effective settings an API caller sees.
package resolve

import (
	"encoding/json"

	"github.com/google/uuid"

	"github.com/connordoman/settings-app/internal/database"
	"github.com/connordoman/settings-app/internal/valuetype"
)

// Source names the layer an effective value came from.
type Source string

const (
	// SourceUnset means no layer supplied a value and no default was declared.
	SourceUnset Source = "UNSET"
	// SourceDefault means the value is the setting definition's default.
	SourceDefault Source = "DEFAULT"
	// SourceServer means an operator set it server-wide.
	SourceServer Source = "SERVER"
	// SourceIntermediate means a group override supplied it.
	SourceIntermediate Source = "INTERMEDIATE"
	// SourcePersonal means the user chose it.
	SourcePersonal Source = "PERSONAL"
)

// Setting is one effective setting.
type Setting struct {
	ID          uuid.UUID             `json:"id"`
	Name        string                `json:"name"`
	Description string                `json:"description,omitempty"`
	Type        valuetype.Kind        `json:"type"`
	TypeConfig  json.RawMessage       `json:"type_config,omitempty"`
	Role        string                `json:"role"`
	Scope       database.SettingScope `json:"scope"`
	Platform    string                `json:"platform"`
	Environment string                `json:"environment"`

	// Value is the effective value, or null when Source is UNSET.
	Value  json.RawMessage `json:"value"`
	Source Source          `json:"source"`

	// Override describes a group override that took effect, if one did.
	Override *Override `json:"override,omitempty"`
}

// Override reports that an intermediate layer supplied or displaced the value.
type Override struct {
	GroupID uuid.UUID `json:"group_id"`
	// Enforced distinguishes the two directions of an intermediate override:
	// an enforced override beats the user's own value, an advisory one only
	// applies because the user has not chosen one.
	Enforced bool `json:"enforced"`
	// Visible tells the calling backend whether to surface this override to
	// the user. When false the user is meant to experience the value as
	// ordinary, so the caller should not draw attention to it.
	Visible bool `json:"visible"`
	// ReplacedValue is the user's own value that an enforced override pushed
	// aside. It is returned so a caller can restore it if the override is
	// later lifted, and is only ever present when Enforced is true.
	ReplacedValue json.RawMessage `json:"replaced_value,omitempty"`
}

// FromUserRows converts the user resolution query's rows.
func FromUserRows(rows []database.ResolveForUserRow) []Setting {
	settings := make([]Setting, 0, len(rows))
	for _, row := range rows {
		setting := Setting{
			ID:          row.ID,
			Name:        row.Name,
			Description: row.Description,
			Type:        row.Type,
			TypeConfig:  omitEmptyConfig(row.TypeConfig),
			Role:        row.Role,
			Scope:       row.Scope,
			Platform:    row.Platform,
			Environment: row.Environment,
			Value:       nullIfAbsent(row.Value),
			Source:      Source(row.Source),
		}
		setting.Override = effectiveOverride(row)
		settings = append(settings, setting)
	}
	return settings
}

// effectiveOverride picks which of the two candidate overrides actually shaped
// the value. An advisory override only applies when the user chose nothing.
func effectiveOverride(row database.ResolveForUserRow) *Override {
	switch {
	case row.EnforcedGroupID != nil:
		override := &Override{
			GroupID:  *row.EnforcedGroupID,
			Enforced: true,
			Visible:  row.EnforcedVisible == nil || *row.EnforcedVisible,
		}
		if len(row.PersonalValue) > 0 {
			override.ReplacedValue = row.PersonalValue
		}
		return override

	case row.AdvisoryGroupID != nil && len(row.PersonalValue) == 0:
		return &Override{
			GroupID:  *row.AdvisoryGroupID,
			Enforced: false,
			Visible:  row.AdvisoryVisible == nil || *row.AdvisoryVisible,
		}
	}
	return nil
}

// FromServerRows converts the server resolution query's rows.
func FromServerRows(rows []database.ResolveServerRow) []Setting {
	settings := make([]Setting, 0, len(rows))
	for _, row := range rows {
		settings = append(settings, Setting{
			ID:          row.ID,
			Name:        row.Name,
			Description: row.Description,
			Type:        row.Type,
			TypeConfig:  omitEmptyConfig(row.TypeConfig),
			Role:        row.Role,
			Scope:       row.Scope,
			Platform:    row.Platform,
			Environment: row.Environment,
			Value:       nullIfAbsent(row.Value),
			Source:      Source(row.Source),
		})
	}
	return settings
}

// nullIfAbsent renders a missing value as JSON null rather than omitting it,
// so a client can always read the field.
func nullIfAbsent(value json.RawMessage) json.RawMessage {
	if len(value) == 0 {
		return json.RawMessage("null")
	}
	return value
}

// omitEmptyConfig drops a type_config that carries no rules.
func omitEmptyConfig(config json.RawMessage) json.RawMessage {
	if len(config) == 0 || string(config) == "{}" {
		return nil
	}
	return config
}
