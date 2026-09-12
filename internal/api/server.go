// Package api serves the App Settings HTTP interface.
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/app-settings/internal/apikey"
	"github.com/connordoman/app-settings/internal/cache"
	"github.com/connordoman/app-settings/internal/config"
	"github.com/connordoman/app-settings/internal/store"
)

// Server wires the HTTP layer to its dependencies.
type Server struct {
	cfg    config.Config
	store  *store.Store
	cache  cache.Cache
	logger *slog.Logger
	engine *gin.Engine
}

// NewServer builds the router.
func NewServer(cfg config.Config, st *store.Store, ca cache.Cache, logger *slog.Logger) *Server {
	if cfg.Debug {
		gin.SetMode(gin.DebugMode)
	} else {
		gin.SetMode(gin.ReleaseMode)
	}

	server := &Server{cfg: cfg, store: st, cache: ca, logger: logger, engine: gin.New()}

	// Gin trusts all proxies by default, which would let any caller spoof its
	// own address through X-Forwarded-For. Trust only what the operator names.
	if err := server.engine.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		logger.Warn("could not apply trusted proxy list", "error", err)
	}

	server.engine.Use(requestID(), server.requestLogger(), server.recovery())
	server.routes()
	return server
}

// Handler exposes the router.
func (s *Server) Handler() http.Handler { return s.engine }

// routes registers every endpoint. Scope requirements sit next to the route
// they guard so the permission model is readable in one place.
func (s *Server) routes() {
	s.engine.GET("/healthz", s.handleHealth)
	s.engine.GET("/readyz", s.handleReady)

	v1 := s.engine.Group("/api/v1", s.authenticate())
	v1.GET("/whoami", s.handleWhoami)

	// API key management. The bootstrap key holds exactly these scopes, which
	// is how it provides CLI access and nothing more.
	keys := v1.Group("/keys")
	{
		keys.GET("", requireScope(apikey.ScopeKeysRead), s.handleListKeys)
		keys.POST("", requireScope(apikey.ScopeKeysWrite), s.handleCreateKey)
		keys.DELETE("/:id", requireScope(apikey.ScopeKeysWrite), s.handleRevokeKey)
	}

	// Roles, platforms and environments.
	read, write := requireScope(apikey.ScopeTaxonomyRead), requireScope(apikey.ScopeTaxonomyWrite)
	v1.GET("/roles", read, s.handleListRoles)
	v1.PUT("/roles/:name", write, s.handleUpsertRole)
	v1.DELETE("/roles/:name", write, s.handleDeleteRole)
	v1.GET("/platforms", read, s.handleListPlatforms)
	v1.PUT("/platforms/:name", write, s.handleUpsertPlatform)
	v1.DELETE("/platforms/:name", write, s.handleDeletePlatform)
	v1.GET("/environments", read, s.handleListEnvironments)
	v1.PUT("/environments/:name", write, s.handleUpsertEnvironment)
	v1.DELETE("/environments/:name", write, s.handleDeleteEnvironment)

	// Setting definitions.
	settings := v1.Group("/settings")
	{
		settings.GET("", requireScope(apikey.ScopeSettingsRead), s.handleListSettings)
		settings.POST("", requireScope(apikey.ScopeSettingsWrite), s.handleCreateSetting)
		settings.GET("/:id", requireScope(apikey.ScopeSettingsRead), s.handleGetSetting)
		settings.PATCH("/:id", requireScope(apikey.ScopeSettingsWrite), s.handleUpdateSetting)
		settings.DELETE("/:id", requireScope(apikey.ScopeSettingsWrite), s.handleDeleteSetting)

		// Values, one route per layer.
		valuesRead, valuesWrite := requireScope(apikey.ScopeValuesRead), requireScope(apikey.ScopeValuesWrite)
		settings.GET("/:id/server", valuesRead, s.handleGetServerValue)
		settings.PUT("/:id/server", valuesWrite, s.handlePutServerValue)
		settings.DELETE("/:id/server", valuesWrite, s.handleDeleteServerValue)

		settings.GET("/:id/personal/:user_id", valuesRead, s.handleGetPersonalValue)
		settings.PUT("/:id/personal/:user_id", valuesWrite, s.handlePutPersonalValue)
		settings.DELETE("/:id/personal/:user_id", valuesWrite, s.handleDeletePersonalValue)

		settings.GET("/:id/intermediate/:group_id", valuesRead, s.handleGetIntermediateValue)
		settings.PUT("/:id/intermediate/:group_id", valuesWrite, s.handlePutIntermediateValue)
		settings.DELETE("/:id/intermediate/:group_id", valuesWrite, s.handleDeleteIntermediateValue)
	}

	// Groups and membership.
	groups := v1.Group("/groups")
	{
		groupsRead, groupsWrite := requireScope(apikey.ScopeGroupsRead), requireScope(apikey.ScopeGroupsWrite)
		groups.GET("", groupsRead, s.handleListGroups)
		groups.POST("", groupsWrite, s.handleCreateGroup)
		groups.GET("/:id", groupsRead, s.handleGetGroup)
		groups.PATCH("/:id", groupsWrite, s.handleUpdateGroup)
		groups.DELETE("/:id", groupsWrite, s.handleDeleteGroup)
		groups.GET("/:id/members", groupsRead, s.handleListGroupMembers)
		groups.POST("/:id/members", groupsWrite, s.handleAddGroupMembers)
		groups.DELETE("/:id/members", groupsWrite, s.handleRemoveGroupMembers)
	}

	// Effective settings. This is the endpoint a product backend calls.
	resolveScope := requireScope(apikey.ScopeResolve)
	v1.GET("/resolve/user/:user_id", resolveScope, s.handleResolveUser)
	v1.GET("/resolve/server", resolveScope, s.handleResolveServer)
}

// handleHealth reports that the process is up.
func (s *Server) handleHealth(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// handleReady reports whether dependencies are reachable.
func (s *Server) handleReady(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()

	body := gin.H{"status": "ok", "database": "ok"}
	status := http.StatusOK

	if err := s.store.Pool().Ping(ctx); err != nil {
		body["database"], body["status"], status = err.Error(), "degraded", http.StatusServiceUnavailable
	}
	if s.cache.Enabled() {
		if err := s.cache.Ping(ctx); err != nil {
			// A dead cache is survivable: resolution falls back to the database.
			body["cache"], body["status"] = err.Error(), "degraded"
		} else {
			body["cache"] = "ok"
		}
	}

	c.JSON(status, body)
}

// handleWhoami describes the calling key, so an operator can confirm what a
// key can actually do without decoding it.
func (s *Server) handleWhoami(c *gin.Context) {
	identity := identityFrom(c)
	c.JSON(http.StatusOK, gin.H{
		"key_id":       identity.KeyID,
		"name":         identity.KeyName,
		"key":          apikey.Display(identity.Prefix),
		"scopes":       identity.Scopes,
		"environments": identity.Environments,
		"platforms":    identity.Platforms,
		"role":         identity.Role,
		"is_bootstrap": identity.IsBootstrap,
	})
}

// requestID attaches an identifier used in logs and echoed to the caller.
func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-ID")
		if id == "" {
			id = uuid.NewString()
		}
		c.Set("request_id", id)
		c.Header("X-Request-ID", id)
		c.Next()
	}
}

// requestLogger logs one line per request. It never logs the Authorization
// header or any request body, both of which carry secrets.
func (s *Server) requestLogger() gin.HandlerFunc {
	return func(c *gin.Context) {
		started := time.Now()
		c.Next()

		level := slog.LevelInfo
		if c.Writer.Status() >= http.StatusInternalServerError {
			level = slog.LevelError
		}

		attributes := []any{
			"method", c.Request.Method,
			"path", c.FullPath(),
			"status", c.Writer.Status(),
			"duration", time.Since(started).Round(time.Microsecond).String(),
			"request_id", c.GetString("request_id"),
		}
		if identity := identityFrom(c); identity.Prefix != "" {
			attributes = append(attributes, "key", identity.Prefix)
		}
		if len(c.Errors) > 0 {
			attributes = append(attributes, "error", c.Errors.String())
		}

		s.logger.Log(c.Request.Context(), level, "request", attributes...)
	}
}

// recovery turns a panic into a 500 without taking the process down.
func (s *Server) recovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if recovered := recover(); recovered != nil {
				s.logger.Error("panic serving request",
					"panic", recovered,
					"path", c.FullPath(),
					"request_id", c.GetString("request_id"))
				fail(c, http.StatusInternalServerError, codeInternal, "internal error")
			}
		}()
		c.Next()
	}
}
