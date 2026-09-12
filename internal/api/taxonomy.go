package api

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/connordoman/settings-app/internal/database"
	"github.com/connordoman/settings-app/internal/store"
)

// taxonomyRequest is the body for creating or updating a role, platform or
// environment. Rank applies only to roles.
type taxonomyRequest struct {
	Description string `json:"description"`
	Rank        *int32 `json:"rank"`
}

func (s *Server) handleListRoles(c *gin.Context) {
	roles, err := s.store.ListRoles(c.Request.Context())
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"roles": roles})
}

func (s *Server) handleUpsertRole(c *gin.Context) {
	var request taxonomyRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}
	if request.Rank == nil {
		failValidation(c, fmt.Errorf("`rank` is required: it orders roles, and a setting is visible to every role ranked at or above its own"))
		return
	}

	// A key must not be able to invent a role that outranks itself.
	if *request.Rank > identityFrom(c).RoleRank {
		failValidation(c, fmt.Errorf("cannot create a role ranked above the key making the request"))
		return
	}

	role, err := s.store.UpsertRole(c.Request.Context(), database.UpsertRoleParams{
		Name:        c.Param("name"),
		Description: request.Description,
		Rank:        *request.Rank,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, role)
}

func (s *Server) handleDeleteRole(c *gin.Context) {
	name := c.Param("name")
	affected, err := s.store.DeleteRole(c.Request.Context(), name)
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		s.explainFailedTaxonomyDelete(c, "role", name)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) handleListPlatforms(c *gin.Context) {
	platforms, err := s.store.ListPlatforms(c.Request.Context())
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"platforms": platforms})
}

func (s *Server) handleUpsertPlatform(c *gin.Context) {
	var request taxonomyRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}

	platform, err := s.store.UpsertPlatform(c.Request.Context(), database.UpsertPlatformParams{
		Name: c.Param("name"), Description: request.Description,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, platform)
}

func (s *Server) handleDeletePlatform(c *gin.Context) {
	name := c.Param("name")
	affected, err := s.store.DeletePlatform(c.Request.Context(), name)
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		s.explainFailedTaxonomyDelete(c, "platform", name)
		return
	}
	c.Status(http.StatusNoContent)
}

func (s *Server) handleListEnvironments(c *gin.Context) {
	environments, err := s.store.ListEnvironments(c.Request.Context())
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"environments": environments})
}

func (s *Server) handleUpsertEnvironment(c *gin.Context) {
	var request taxonomyRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}

	name := c.Param("name")
	if !requireEnvironment(c, name) {
		return
	}

	environment, err := s.store.UpsertEnvironment(c.Request.Context(), database.UpsertEnvironmentParams{
		Name: name, Description: request.Description,
	})
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, environment)
}

func (s *Server) handleDeleteEnvironment(c *gin.Context) {
	name := c.Param("name")
	if !requireEnvironment(c, name) {
		return
	}

	affected, err := s.store.DeleteEnvironment(c.Request.Context(), name)
	if err != nil {
		failStore(c, err)
		return
	}
	if affected == 0 {
		s.explainFailedTaxonomyDelete(c, "environment", name)
		return
	}
	c.Status(http.StatusNoContent)
}

// explainFailedTaxonomyDelete tells the caller which of the two reasons a
// delete matched no rows: the row is absent, or it is a protected system row.
func (s *Server) explainFailedTaxonomyDelete(c *gin.Context, kind, name string) {
	exists, err := s.taxonomyExists(c, kind, name)
	if err != nil {
		failStore(c, err)
		return
	}
	if !exists {
		fail(c, http.StatusNotFound, codeNotFound, fmt.Sprintf("no %s named %q", kind, name))
		return
	}
	fail(c, http.StatusConflict, codeConflict,
		fmt.Sprintf("the %q %s is built in and cannot be removed", name, kind))
}

func (s *Server) taxonomyExists(c *gin.Context, kind, name string) (bool, error) {
	ctx := c.Request.Context()

	var err error
	switch kind {
	case "role":
		_, err = s.store.GetRole(ctx, name)
	case "platform":
		_, err = s.store.GetPlatform(ctx, name)
	case "environment":
		_, err = s.store.GetEnvironment(ctx, name)
	}

	switch {
	case err == nil:
		return true, nil
	case store.IsNotFound(store.Classify(err)):
		return false, nil
	default:
		return false, err
	}
}
