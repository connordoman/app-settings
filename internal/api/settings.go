package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/settings-app/internal/database"
	"github.com/connordoman/settings-app/internal/valuetype"
)

// createSettingRequest defines a new setting.
type createSettingRequest struct {
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Type        valuetype.Kind        `json:"type"`
	TypeConfig  json.RawMessage       `json:"type_config"`
	Role        string                `json:"role"`
	Scope       database.SettingScope `json:"scope"`
	Platform    string                `json:"platform"`
	Environment string                `json:"environment"`
	// DefaultValue is used when no layer supplies a value.
	DefaultValue json.RawMessage `json:"default_value"`
}

// updateSettingRequest changes the parts of a definition that are safe to
// change. Type, scope, platform and environment are fixed at creation: values
// already stored would no longer be meaningful under a different type.
type updateSettingRequest struct {
	Description  *string         `json:"description"`
	TypeConfig   json.RawMessage `json:"type_config"`
	Role         *string         `json:"role"`
	DefaultValue json.RawMessage `json:"default_value"`
}

func (s *Server) handleListSettings(c *gin.Context) {
	identity := identityFrom(c)

	environment := c.Query("environment")
	if environment != "" && !requireEnvironment(c, environment) {
		return
	}
	platform := c.Query("platform")
	if !requirePlatform(c, platform) {
		return
	}

	scope := c.Query("scope")
	if scope != "" && !validScope(database.SettingScope(scope)) {
		failValidation(c, fmt.Errorf("`scope` must be PERSONAL, INTERMEDIATE or SERVER"))
		return
	}

	settings, err := s.store.ListSettings(c.Request.Context(), database.ListSettingsParams{
		Environment: environment,
		Platform:    platform,
		Scope:       scope,
		MaxRank:     identity.RoleRank,
	})
	if err != nil {
		failStore(c, err)
		return
	}

	// A key fenced into particular environments must not see the others, even
	// when it did not name one in the query.
	visible := make([]database.Setting, 0, len(settings))
	for _, setting := range settings {
		if identity.AllowsEnvironment(setting.Environment) && identity.AllowsPlatform(setting.Platform) {
			visible = append(visible, setting)
		}
	}

	c.JSON(http.StatusOK, gin.H{"settings": visible})
}

func (s *Server) handleGetSetting(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, setting)
}

func (s *Server) handleCreateSetting(c *gin.Context) {
	var request createSettingRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}

	if request.Name == "" {
		failValidation(c, fmt.Errorf("`name` is required"))
		return
	}
	if !valuetype.ValidKind(request.Type) {
		failValidation(c, fmt.Errorf("`type` must be one of %s", valuetype.KindNames()))
		return
	}
	if !validScope(request.Scope) {
		failValidation(c, fmt.Errorf("`scope` must be PERSONAL, INTERMEDIATE or SERVER"))
		return
	}
	if !requireEnvironment(c, request.Environment) || !requirePlatform(c, request.Platform) {
		return
	}

	identity := identityFrom(c)
	if request.Role == "" {
		request.Role = identity.Role
	}
	if err := s.checkRoleCeiling(c, request.Role, identity.RoleRank); err != nil {
		failValidation(c, err)
		return
	}

	// Validate the type rules first, then the default value against them, so a
	// definition can never be stored in a state where its own default is invalid.
	config, defaultValue, err := s.normaliseDefinition(request.Type, request.TypeConfig, request.DefaultValue)
	if err != nil {
		failValidation(c, err)
		return
	}

	setting, err := s.store.CreateSetting(c.Request.Context(), database.CreateSettingParams{
		Name:         request.Name,
		Description:  request.Description,
		Type:         request.Type,
		TypeConfig:   config,
		Role:         request.Role,
		Scope:        request.Scope,
		Platform:     request.Platform,
		Environment:  request.Environment,
		DefaultValue: defaultValue,
		Actor:        identity.Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidate(c, setting.Environment)
	c.JSON(http.StatusCreated, setting)
}

func (s *Server) handleUpdateSetting(c *gin.Context) {
	existing, ok := s.settingForRequest(c)
	if !ok {
		return
	}

	var request updateSettingRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}

	identity := identityFrom(c)
	updated := database.UpdateSettingParams{
		ID:           existing.ID,
		Description:  existing.Description,
		TypeConfig:   existing.TypeConfig,
		Role:         existing.Role,
		DefaultValue: existing.DefaultValue,
		Actor:        identity.Actor(),
	}

	if request.Description != nil {
		updated.Description = *request.Description
	}
	if request.Role != nil {
		if err := s.checkRoleCeiling(c, *request.Role, identity.RoleRank); err != nil {
			failValidation(c, err)
			return
		}
		updated.Role = *request.Role
	}
	if request.TypeConfig != nil {
		updated.TypeConfig = request.TypeConfig
	}
	if request.DefaultValue != nil {
		updated.DefaultValue = request.DefaultValue
	}

	config, defaultValue, err := s.normaliseDefinition(existing.Type, updated.TypeConfig, updated.DefaultValue)
	if err != nil {
		failValidation(c, err)
		return
	}
	updated.TypeConfig, updated.DefaultValue = config, defaultValue

	setting, err := s.store.UpdateSetting(c.Request.Context(), updated)
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidate(c, setting.Environment)
	c.JSON(http.StatusOK, setting)
}

func (s *Server) handleDeleteSetting(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}

	// Deleting a definition cascades to every value stored against it, so say
	// how much would be destroyed unless the caller confirms.
	if c.Query("cascade") != "true" {
		count, err := s.store.CountSettingValues(c.Request.Context(), setting.ID)
		if err != nil {
			failStore(c, err)
			return
		}
		if count > 0 {
			fail(c, http.StatusConflict, codeConflict, fmt.Sprintf(
				"%d stored values would be deleted with this setting; repeat with ?cascade=true to confirm", count))
			return
		}
	}

	if _, err := s.store.DeleteSetting(c.Request.Context(), setting.ID); err != nil {
		failStore(c, err)
		return
	}

	s.invalidate(c, setting.Environment)
	c.Status(http.StatusNoContent)
}

// normaliseDefinition validates a setting's type rules and its default value
// against them, returning both in canonical form.
func (s *Server) normaliseDefinition(kind valuetype.Kind, rawConfig, rawDefault json.RawMessage) (json.RawMessage, json.RawMessage, error) {
	parsed, err := valuetype.ParseConfig(rawConfig)
	if err != nil {
		return nil, nil, err
	}
	validated, err := valuetype.ValidateConfig(kind, parsed)
	if err != nil {
		return nil, nil, fmt.Errorf("type_config: %w", err)
	}

	config, err := json.Marshal(validated)
	if err != nil {
		return nil, nil, err
	}

	if len(rawDefault) == 0 || string(rawDefault) == "null" {
		return config, nil, nil
	}
	defaultValue, err := valuetype.Validate(kind, validated, rawDefault)
	if err != nil {
		return nil, nil, fmt.Errorf("default_value: %w", err)
	}
	return config, defaultValue, nil
}

// settingForRequest loads the setting named in the path and confirms the key
// is allowed to see it at all.
func (s *Server) settingForRequest(c *gin.Context) (database.Setting, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		failValidation(c, fmt.Errorf("`%s` is not a valid setting id", c.Param("id")))
		return database.Setting{}, false
	}

	setting, err := s.store.GetSetting(c.Request.Context(), id)
	if err != nil {
		failStore(c, err)
		return database.Setting{}, false
	}

	identity := identityFrom(c)
	if !identity.AllowsEnvironment(setting.Environment) || !identity.AllowsPlatform(setting.Platform) {
		// Report it as missing: a key fenced out of an environment should not
		// learn which settings exist there.
		fail(c, http.StatusNotFound, codeNotFound, "not found")
		return database.Setting{}, false
	}

	role, err := s.store.GetRole(c.Request.Context(), setting.Role)
	if err != nil {
		failStore(c, err)
		return database.Setting{}, false
	}
	if role.Rank > identity.RoleRank {
		fail(c, http.StatusNotFound, codeNotFound, "not found")
		return database.Setting{}, false
	}

	return setting, true
}

// validScope reports whether a scope is one of the three the schema allows.
func validScope(scope database.SettingScope) bool {
	switch scope {
	case database.SettingScopePERSONAL, database.SettingScopeINTERMEDIATE, database.SettingScopeSERVER:
		return true
	}
	return false
}

// invalidate clears cached resolutions for an environment after a write.
func (s *Server) invalidate(c *gin.Context, environment string) {
	s.cache.InvalidateEnvironment(c.Request.Context(), environment)
}
