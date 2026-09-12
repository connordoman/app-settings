package api

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/app-settings/internal/apikey"
	"github.com/connordoman/app-settings/internal/database"
	"github.com/connordoman/app-settings/internal/store"
)

// identityKey is where the authenticated key is stashed on the request.
const identityKey = "settings.identity"

// Identity is the authenticated API key behind a request.
type Identity struct {
	KeyID        uuid.UUID
	KeyName      string
	Prefix       string
	Scopes       []string
	Environments []string
	Platforms    []string
	Role         string
	RoleRank     int32
	IsBootstrap  bool
}

// Actor names this key in created_by and updated_by columns.
func (i Identity) Actor() string { return "key:" + i.Prefix }

// AllowsEnvironment reports whether the key may touch an environment. An empty
// filter means every environment.
func (i Identity) AllowsEnvironment(environment string) bool {
	return len(i.Environments) == 0 || slices.Contains(i.Environments, environment)
}

// AllowsPlatform reports whether the key may touch a platform.
func (i Identity) AllowsPlatform(platform string) bool {
	return len(i.Platforms) == 0 || slices.Contains(i.Platforms, platform)
}

// identityFrom returns the authenticated key for a request.
func identityFrom(c *gin.Context) Identity {
	value, _ := c.Get(identityKey)
	identity, _ := value.(Identity)
	return identity
}

// decoyHash keeps authentication timing independent of whether a prefix
// exists, so the endpoint cannot be used to enumerate valid prefixes.
var decoyHash = func() []byte {
	sum := sha256.Sum256([]byte("app-settings decoy"))
	return sum[:]
}()

// authenticate validates the presented API key and attaches its identity.
func (s *Server) authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		presented, ok := bearerToken(c.Request.Header)
		if !ok {
			fail(c, http.StatusUnauthorized, codeUnauthorized,
				"provide an API key as `Authorization: Bearer <key>` or `X-API-Key: <key>`")
			return
		}

		prefix, err := apikey.Parse(presented)
		if err != nil {
			fail(c, http.StatusUnauthorized, codeUnauthorized, "invalid API key")
			return
		}

		row, err := s.store.GetApiKeyForAuth(c.Request.Context(), prefix)
		if err != nil {
			if !store.IsNotFound(store.Classify(err)) {
				_ = c.Error(err)
				fail(c, http.StatusInternalServerError, codeInternal, "internal error")
				return
			}
			// Spend the same work on an unknown prefix as on a known one.
			apikey.Verify(presented, decoyHash)
			fail(c, http.StatusUnauthorized, codeUnauthorized, "invalid API key")
			return
		}

		if !apikey.Verify(presented, row.SecretHash) {
			fail(c, http.StatusUnauthorized, codeUnauthorized, "invalid API key")
			return
		}
		if row.RevokedAt != nil {
			fail(c, http.StatusUnauthorized, codeUnauthorized, "this API key has been revoked")
			return
		}
		if row.ExpiresAt != nil && row.ExpiresAt.Before(time.Now()) {
			fail(c, http.StatusUnauthorized, codeUnauthorized, "this API key has expired")
			return
		}

		c.Set(identityKey, Identity{
			KeyID:        row.ID,
			KeyName:      row.Name,
			Prefix:       row.Prefix,
			Scopes:       row.Scopes,
			Environments: row.Environments,
			Platforms:    row.Platforms,
			Role:         row.Role,
			RoleRank:     row.RoleRank,
			IsBootstrap:  row.IsBootstrap,
		})

		s.recordKeyUse(row.ID)
		c.Next()
	}
}

// bearerToken pulls the key out of either supported header.
func bearerToken(header http.Header) (string, bool) {
	if raw := header.Get("Authorization"); raw != "" {
		scheme, token, found := strings.Cut(raw, " ")
		if found && strings.EqualFold(scheme, "Bearer") {
			if token = strings.TrimSpace(token); token != "" {
				return token, true
			}
		}
		return "", false
	}
	if raw := strings.TrimSpace(header.Get("X-API-Key")); raw != "" {
		return raw, true
	}
	return "", false
}

// recordKeyUse stamps last_used_at without delaying the response. The query
// throttles itself, so this is a no-op write most of the time.
func (s *Server) recordKeyUse(keyID uuid.UUID) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		_ = s.store.TouchApiKey(ctx, database.TouchApiKeyParams{
			ID:              keyID,
			ThrottleSeconds: int32(s.cfg.LastUsedThrottle.Seconds()),
		})
	}()
}

// requireScope rejects a request whose key lacks the needed capability.
func requireScope(required apikey.Scope) gin.HandlerFunc {
	return func(c *gin.Context) {
		identity := identityFrom(c)
		if !apikey.Grants(identity.Scopes, required) {
			fail(c, http.StatusForbidden, codeForbidden,
				"this API key does not have the `"+string(required)+"` scope")
			return
		}
		c.Next()
	}
}

// requireEnvironment rejects a request for an environment the key is fenced
// out of. This is what keeps a staging key from reading production.
func requireEnvironment(c *gin.Context, environment string) bool {
	if environment == "" {
		failValidation(c, errors.New("an `environment` is required"))
		return false
	}
	if !identityFrom(c).AllowsEnvironment(environment) {
		fail(c, http.StatusForbidden, codeForbidden,
			"this API key is not permitted in the `"+environment+"` environment")
		return false
	}
	return true
}

// requirePlatform rejects a request for a platform the key is fenced out of.
func requirePlatform(c *gin.Context, platform string) bool {
	if platform == "" {
		return true
	}
	if !identityFrom(c).AllowsPlatform(platform) {
		fail(c, http.StatusForbidden, codeForbidden,
			"this API key is not permitted on the `"+platform+"` platform")
		return false
	}
	return true
}
