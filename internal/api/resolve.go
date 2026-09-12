package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/app-settings/internal/cache"
	"github.com/connordoman/app-settings/internal/database"
	"github.com/connordoman/app-settings/internal/resolve"
)

// resolveResponse is what a product backend consumes.
type resolveResponse struct {
	Environment string            `json:"environment"`
	Platforms   []string          `json:"platforms,omitempty"`
	UserID      string            `json:"user_id,omitempty"`
	Role        string            `json:"role"`
	Settings    []resolve.Setting `json:"settings"`
	ResolvedAt  time.Time         `json:"resolved_at"`
}

// handleResolveUser returns every setting a user can see, already collapsed to
// one effective value per setting.
func (s *Server) handleResolveUser(c *gin.Context) {
	environment := c.Query("environment")
	if !requireEnvironment(c, environment) {
		return
	}

	platforms, ok := s.requestedPlatforms(c)
	if !ok {
		return
	}

	role, maxRank, ok := s.requestedRole(c)
	if !ok {
		return
	}

	adHocGroups, ok := parseGroupIDs(c)
	if !ok {
		return
	}

	userID := c.Param("user_id")
	key := cache.Key{
		Environment: environment,
		Platforms:   platforms,
		UserID:      userID,
		MaxRank:     maxRank,
		AdHocGroups: c.QueryArray("group_id"),
	}

	if payload, hit := s.cache.Get(c.Request.Context(), key); hit {
		c.Header("X-Cache", "hit")
		c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
		return
	}

	rows, err := s.store.ResolveForUser(c.Request.Context(), database.ResolveForUserParams{
		UserID:        userID,
		Environment:   environment,
		Platforms:     platforms,
		MaxRank:       maxRank,
		AdHocGroupIds: adHocGroups,
	})
	if err != nil {
		failStore(c, err)
		return
	}

	response := resolveResponse{
		Environment: environment,
		Platforms:   platforms,
		UserID:      userID,
		Role:        role,
		Settings:    resolve.FromUserRows(rows),
		ResolvedAt:  time.Now().UTC(),
	}

	// Cache the encoded response so a hit costs one Redis read and no encoding.
	payload, err := json.Marshal(response)
	if err != nil {
		_ = c.Error(err)
		fail(c, http.StatusInternalServerError, codeInternal, "internal error")
		return
	}
	s.cache.Put(c.Request.Context(), key, payload)

	c.Header("X-Cache", "miss")
	c.Data(http.StatusOK, "application/json; charset=utf-8", payload)
}

// handleResolveServer returns the server's own settings.
func (s *Server) handleResolveServer(c *gin.Context) {
	environment := c.Query("environment")
	if !requireEnvironment(c, environment) {
		return
	}

	platforms, ok := s.requestedPlatforms(c)
	if !ok {
		return
	}
	role, maxRank, ok := s.requestedRole(c)
	if !ok {
		return
	}

	rows, err := s.store.ResolveServer(c.Request.Context(), database.ResolveServerParams{
		Environment: environment,
		Platforms:   platforms,
		MaxRank:     maxRank,
	})
	if err != nil {
		failStore(c, err)
		return
	}

	c.JSON(http.StatusOK, resolveResponse{
		Environment: environment,
		Platforms:   platforms,
		Role:        role,
		Settings:    resolve.FromServerRows(rows),
		ResolvedAt:  time.Now().UTC(),
	})
}

// requestedPlatforms reads the platform filter, defaulting to the key's own
// allowed platforms so a fenced key cannot read past its fence.
func (s *Server) requestedPlatforms(c *gin.Context) ([]string, bool) {
	identity := identityFrom(c)
	requested := c.QueryArray("platform")

	if len(requested) == 0 {
		// Nil means "no filter" to the query; the key's own list narrows it.
		return identity.Platforms, true
	}
	for _, platform := range requested {
		if !identity.AllowsPlatform(platform) {
			fail(c, http.StatusForbidden, codeForbidden,
				"this API key is not permitted on the `"+platform+"` platform")
			return nil, false
		}
	}
	return requested, true
}

// requestedRole resolves the role a resolution runs as. It is capped by the
// key's own role, so a key can never see settings above its rank.
func (s *Server) requestedRole(c *gin.Context) (string, int32, bool) {
	identity := identityFrom(c)

	requested := c.Query("role")
	if requested == "" {
		return identity.Role, identity.RoleRank, true
	}

	role, err := s.store.GetRole(c.Request.Context(), requested)
	if err != nil {
		failValidation(c, fmt.Errorf("no such role %q", requested))
		return "", 0, false
	}
	if role.Rank > identity.RoleRank {
		fail(c, http.StatusForbidden, codeForbidden,
			fmt.Sprintf("this API key cannot resolve as %q: that role outranks it", requested))
		return "", 0, false
	}
	return role.Name, role.Rank, true
}

// parseGroupIDs reads ad-hoc group ids from the query string. They let a
// caller apply a group the user is not a saved member of, which is how an
// ad-hoc group is used without persisting membership.
func parseGroupIDs(c *gin.Context) ([]uuid.UUID, bool) {
	raw := c.QueryArray("group_id")
	groups := make([]uuid.UUID, 0, len(raw))

	for _, value := range raw {
		id, err := uuid.Parse(value)
		if err != nil {
			failValidation(c, fmt.Errorf("`%s` is not a valid group id", value))
			return nil, false
		}
		groups = append(groups, id)
	}
	return groups, true
}
