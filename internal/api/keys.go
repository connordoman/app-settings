package api

import (
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/app-settings/internal/apikey"
	"github.com/connordoman/app-settings/internal/database"
)

// createKeyRequest is the body of POST /api/v1/keys.
type createKeyRequest struct {
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
	// Empty means every environment the creating key may reach.
	Environments []string `json:"environments"`
	Platforms    []string `json:"platforms"`
	// Role caps what a request made with this key can see. Defaults to the
	// lowest-ranked role, so an unspecified key is the least powerful one.
	Role string `json:"role"`
	// Supply at most one of these. ExpiresIn is a Go duration such as "720h".
	ExpiresAt *time.Time `json:"expires_at"`
	ExpiresIn string     `json:"expires_in"`
}

// createKeyResponse returns the token exactly once.
type createKeyResponse struct {
	Key database.CreateApiKeyRow `json:"key"`
	// Token is the only time the full key is ever available.
	Token   string `json:"token"`
	Warning string `json:"warning"`
}

func (s *Server) handleCreateKey(c *gin.Context) {
	var request createKeyRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}
	if request.Name == "" {
		failValidation(c, fmt.Errorf("`name` is required so the key can be recognised later"))
		return
	}

	scopes, err := apikey.ParseScopes(request.Scopes)
	if err != nil {
		failValidation(c, err)
		return
	}

	creator := identityFrom(c)
	expiresAt, err := resolveExpiry(request)
	if err != nil {
		failValidation(c, err)
		return
	}

	// A key may never mint one that reaches further than itself.
	environments, err := narrowFilter("environments", request.Environments, creator.Environments)
	if err != nil {
		failValidation(c, err)
		return
	}
	platforms, err := narrowFilter("platforms", request.Platforms, creator.Platforms)
	if err != nil {
		failValidation(c, err)
		return
	}

	role := request.Role
	if role == "" {
		role = s.lowestRole(c)
	}
	if err := s.checkRoleCeiling(c, role, creator.RoleRank); err != nil {
		failValidation(c, err)
		return
	}

	token, err := apikey.Generate()
	if err != nil {
		_ = c.Error(err)
		fail(c, http.StatusInternalServerError, codeInternal, "could not generate a key")
		return
	}

	created, err := s.store.CreateApiKey(c.Request.Context(), database.CreateApiKeyParams{
		Name:         request.Name,
		Prefix:       token.Prefix,
		SecretHash:   token.Hash(),
		Scopes:       apikey.Strings(scopes),
		Environments: orEmpty(environments),
		Platforms:    orEmpty(platforms),
		Role:         role,
		IsBootstrap:  false,
		ExpiresAt:    expiresAt,
		Actor:        creator.Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.logger.Info("api key created",
		"key", token.Prefix, "name", request.Name, "scopes", scopes, "by", creator.Prefix)

	c.JSON(http.StatusCreated, createKeyResponse{
		Key:     created,
		Token:   token.String(),
		Warning: "Store this token now. It is not recoverable: only its hash is kept.",
	})
}

func (s *Server) handleListKeys(c *gin.Context) {
	includeRevoked := c.Query("include_revoked") == "true"

	keys, err := s.store.ListApiKeys(c.Request.Context(), includeRevoked)
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"keys": keys})
}

func (s *Server) handleRevokeKey(c *gin.Context) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		failValidation(c, fmt.Errorf("`%s` is not a valid key id", c.Param("id")))
		return
	}

	identity := identityFrom(c)
	if id == identity.KeyID {
		failValidation(c, fmt.Errorf("a key cannot revoke itself; use another key"))
		return
	}

	affected, err := s.store.RevokeApiKey(c.Request.Context(), database.RevokeApiKeyParams{
		ID: id, Actor: identity.Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		fail(c, http.StatusNotFound, codeNotFound, "no active key with that id")
		return
	}

	s.logger.Info("api key revoked", "key_id", id, "by", identity.Prefix)
	c.Status(http.StatusNoContent)
}

// resolveExpiry turns either expiry field into a timestamp.
func resolveExpiry(request createKeyRequest) (*time.Time, error) {
	if request.ExpiresAt != nil && request.ExpiresIn != "" {
		return nil, fmt.Errorf("supply `expires_at` or `expires_in`, not both")
	}
	if request.ExpiresAt != nil {
		if request.ExpiresAt.Before(time.Now()) {
			return nil, fmt.Errorf("`expires_at` is in the past")
		}
		return request.ExpiresAt, nil
	}
	if request.ExpiresIn != "" {
		duration, err := time.ParseDuration(request.ExpiresIn)
		if err != nil {
			return nil, fmt.Errorf("`expires_in` must be a duration such as \"720h\": %w", err)
		}
		if duration <= 0 {
			return nil, fmt.Errorf("`expires_in` must be positive")
		}
		expiry := time.Now().Add(duration)
		return &expiry, nil
	}
	return nil, nil
}

// narrowFilter enforces that a new key's environment or platform filter is no
// broader than the creating key's. An unrestricted creator may grant anything.
func narrowFilter(field string, requested, creatorFilter []string) ([]string, error) {
	if len(creatorFilter) == 0 {
		return requested, nil
	}
	if len(requested) == 0 {
		// Inherit rather than silently granting everything.
		return creatorFilter, nil
	}
	for _, value := range requested {
		if !slices.Contains(creatorFilter, value) {
			return nil, fmt.Errorf(
				"cannot grant %s %q: the key creating it is limited to %v", field, value, creatorFilter)
		}
	}
	return requested, nil
}

// orEmpty normalises a nil slice to an empty one. The filter columns are NOT
// NULL, and a client that omits the field entirely sends JSON null.
func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// checkRoleCeiling stops a key from minting one that outranks it.
func (s *Server) checkRoleCeiling(c *gin.Context, role string, creatorRank int32) error {
	found, err := s.store.GetRole(c.Request.Context(), role)
	if err != nil {
		return fmt.Errorf("no such role %q", role)
	}
	if found.Rank > creatorRank {
		return fmt.Errorf("cannot grant role %q: it outranks the key creating it", role)
	}
	return nil
}

// lowestRole returns the least powerful role, used as the default for a new key.
func (s *Server) lowestRole(c *gin.Context) string {
	roles, err := s.store.ListRoles(c.Request.Context())
	if err != nil || len(roles) == 0 {
		return "user"
	}
	return roles[0].Name // ListRoles orders by rank ascending.
}
