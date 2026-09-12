package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/settings-app/internal/database"
	"github.com/connordoman/settings-app/internal/valuetype"
)

// valueRequest carries a value for any layer. Visible and Enforced apply only
// to the intermediate layer.
type valueRequest struct {
	Value json.RawMessage `json:"value"`
	// Visible tells the calling backend whether to surface the override to the
	// user. Defaults to true.
	Visible *bool `json:"visible"`
	// Enforced makes the override beat the user's own value instead of
	// yielding to it. Defaults to false.
	Enforced *bool `json:"enforced"`
}

func (s *Server) handleGetServerValue(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}

	value, err := s.store.GetServerValue(c.Request.Context(), setting.ID)
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, value)
}

func (s *Server) handlePutServerValue(c *gin.Context) {
	setting, request, ok := s.valueWriteContext(c)
	if !ok {
		return
	}

	value, err := s.store.UpsertServerValue(c.Request.Context(), database.UpsertServerValueParams{
		SettingID: setting.ID,
		Value:     request.Value,
		Actor:     identityFrom(c).Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidate(c, setting.Environment)
	c.JSON(http.StatusOK, value)
}

func (s *Server) handleDeleteServerValue(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}

	affected, err := s.store.DeleteServerValue(c.Request.Context(), setting.ID)
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		fail(c, http.StatusNotFound, codeNotFound, "this setting has no server value")
		return
	}

	s.invalidate(c, setting.Environment)
	c.Status(http.StatusNoContent)
}

func (s *Server) handleGetPersonalValue(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}

	value, err := s.store.GetPersonalValue(c.Request.Context(), database.GetPersonalValueParams{
		UserID: c.Param("user_id"), SettingID: setting.ID,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, value)
}

func (s *Server) handlePutPersonalValue(c *gin.Context) {
	setting, request, ok := s.valueWriteContext(c)
	if !ok {
		return
	}

	value, err := s.store.UpsertPersonalValue(c.Request.Context(), database.UpsertPersonalValueParams{
		UserID:    c.Param("user_id"),
		SettingID: setting.ID,
		Value:     request.Value,
		Actor:     identityFrom(c).Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidate(c, setting.Environment)
	c.JSON(http.StatusOK, value)
}

func (s *Server) handleDeletePersonalValue(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}

	affected, err := s.store.DeletePersonalValue(c.Request.Context(), database.DeletePersonalValueParams{
		UserID: c.Param("user_id"), SettingID: setting.ID,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		fail(c, http.StatusNotFound, codeNotFound, "this user has no value for that setting")
		return
	}

	s.invalidate(c, setting.Environment)
	c.Status(http.StatusNoContent)
}

func (s *Server) handleGetIntermediateValue(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}
	groupID, ok := parseGroupID(c)
	if !ok {
		return
	}

	value, err := s.store.GetIntermediateValue(c.Request.Context(), database.GetIntermediateValueParams{
		GroupID: groupID, SettingID: setting.ID,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, value)
}

func (s *Server) handlePutIntermediateValue(c *gin.Context) {
	setting, request, ok := s.valueWriteContext(c)
	if !ok {
		return
	}
	groupID, ok := parseGroupID(c)
	if !ok {
		return
	}

	value, err := s.store.UpsertIntermediateValue(c.Request.Context(), database.UpsertIntermediateValueParams{
		GroupID:    groupID,
		SettingID:  setting.ID,
		Value:      request.Value,
		Visible:    request.Visible == nil || *request.Visible,
		IsEnforced: request.Enforced != nil && *request.Enforced,
		Actor:      identityFrom(c).Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidate(c, setting.Environment)
	c.JSON(http.StatusOK, value)
}

func (s *Server) handleDeleteIntermediateValue(c *gin.Context) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return
	}
	groupID, ok := parseGroupID(c)
	if !ok {
		return
	}

	affected, err := s.store.DeleteIntermediateValue(c.Request.Context(), database.DeleteIntermediateValueParams{
		GroupID: groupID, SettingID: setting.ID,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		fail(c, http.StatusNotFound, codeNotFound, "this group has no override for that setting")
		return
	}

	s.invalidate(c, setting.Environment)
	c.Status(http.StatusNoContent)
}

// valueWriteContext loads the setting, decodes the body, checks that the
// layer being written is one the setting's scope permits, and normalises the
// value against the setting's type.
func (s *Server) valueWriteContext(c *gin.Context) (database.Setting, valueRequest, bool) {
	setting, ok := s.settingForRequest(c)
	if !ok {
		return setting, valueRequest{}, false
	}

	var request valueRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return setting, request, false
	}
	if len(request.Value) == 0 {
		failValidation(c, fmt.Errorf("`value` is required; use DELETE to clear a value"))
		return setting, request, false
	}

	// The database enforces this too, but catching it here gives a message
	// that names the layer the caller actually used.
	layer := layerFromPath(c.FullPath())
	if !scopeAllowsLayer(setting.Scope, layer) {
		failValidation(c, fmt.Errorf(
			"setting %q is scoped %s, so it cannot hold a %s value", setting.Name, setting.Scope, layer))
		return setting, request, false
	}

	config, err := valuetype.ParseConfig(setting.TypeConfig)
	if err != nil {
		_ = c.Error(err)
		fail(c, http.StatusInternalServerError, codeInternal, "this setting's stored type configuration is unreadable")
		return setting, request, false
	}

	normalised, err := valuetype.Validate(setting.Type, config, request.Value)
	if err != nil {
		failValidation(c, fmt.Errorf("value: %w", err))
		return setting, request, false
	}
	request.Value = normalised

	return setting, request, true
}

// layerFromPath names the value layer a route writes to.
func layerFromPath(route string) string {
	switch {
	case strings.HasSuffix(route, "/server"):
		return "server"
	case strings.Contains(route, "/personal/"):
		return "personal"
	case strings.Contains(route, "/intermediate/"):
		return "intermediate"
	}
	return "unknown"
}

// scopeAllowsLayer mirrors the assert_layer_allowed trigger in migration 005.
func scopeAllowsLayer(scope database.SettingScope, layer string) bool {
	switch layer {
	case "server":
		return true
	case "intermediate":
		return scope == database.SettingScopeINTERMEDIATE || scope == database.SettingScopePERSONAL
	case "personal":
		return scope == database.SettingScopePERSONAL
	}
	return false
}

func parseGroupID(c *gin.Context) (uuid.UUID, bool) {
	groupID, err := uuid.Parse(c.Param("group_id"))
	if err != nil {
		failValidation(c, fmt.Errorf("`%s` is not a valid group id", c.Param("group_id")))
		return uuid.UUID{}, false
	}
	return groupID, true
}
