package api

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/connordoman/settings-app/internal/database"
)

// createGroupRequest defines a group of users for the intermediate layer.
type createGroupRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Environment scopes the group; omit it to apply across all environments.
	Environment *string `json:"environment"`
	// Priority breaks ties when a user is in several groups overriding the
	// same setting. Higher wins.
	Priority int32 `json:"priority"`
	// Ephemeral marks an ad-hoc group, assembled for one purpose rather than
	// saved for reuse. It behaves identically; the flag lets operators prune.
	Ephemeral bool `json:"ephemeral"`
	// Members seeds the group in the same request.
	Members []string `json:"members"`
}

type updateGroupRequest struct {
	Description *string `json:"description"`
	Priority    *int32  `json:"priority"`
}

// membersRequest carries user identifiers for membership changes.
type membersRequest struct {
	Members []string `json:"members"`
}

func (s *Server) handleListGroups(c *gin.Context) {
	environment := c.Query("environment")
	if environment != "" && !requireEnvironment(c, environment) {
		return
	}

	groups, err := s.store.ListGroups(c.Request.Context(), database.ListGroupsParams{
		Environment:      environment,
		IncludeEphemeral: c.Query("include_ephemeral") != "false",
	})
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"groups": s.visibleGroups(c, groups)})
}

func (s *Server) handleGetGroup(c *gin.Context) {
	group, ok := s.groupForRequest(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, group)
}

func (s *Server) handleCreateGroup(c *gin.Context) {
	var request createGroupRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}
	if request.Name == "" {
		failValidation(c, fmt.Errorf("`name` is required"))
		return
	}
	if request.Environment != nil && !requireEnvironment(c, *request.Environment) {
		return
	}
	// A key fenced into specific environments may not create a group that
	// spans all of them.
	if request.Environment == nil && len(identityFrom(c).Environments) > 0 {
		failValidation(c, fmt.Errorf(
			"this API key is limited to specific environments, so `environment` is required"))
		return
	}

	actor := identityFrom(c).Actor()

	// Creating the group and seeding its members is one unit of work: a group
	// that half exists would be worse than none.
	var group database.Group
	err := s.store.InTx(c.Request.Context(), func(q *database.Queries) error {
		var err error
		group, err = q.CreateGroup(c.Request.Context(), database.CreateGroupParams{
			Name:        request.Name,
			Description: request.Description,
			Environment: request.Environment,
			Priority:    request.Priority,
			IsEphemeral: request.Ephemeral,
			Actor:       actor,
		})
		if err != nil {
			return err
		}
		if len(request.Members) == 0 {
			return nil
		}
		return q.AddGroupMembers(c.Request.Context(), database.AddGroupMembersParams{
			GroupID: group.ID, UserIds: request.Members, Actor: actor,
		})
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidateGroup(c, group)
	c.JSON(http.StatusCreated, group)
}

func (s *Server) handleUpdateGroup(c *gin.Context) {
	existing, ok := s.groupForRequest(c)
	if !ok {
		return
	}

	var request updateGroupRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return
	}

	params := database.UpdateGroupParams{
		ID:          existing.ID,
		Description: existing.Description,
		Priority:    existing.Priority,
		Actor:       identityFrom(c).Actor(),
	}
	if request.Description != nil {
		params.Description = *request.Description
	}
	if request.Priority != nil {
		params.Priority = *request.Priority
	}

	group, err := s.store.UpdateGroup(c.Request.Context(), params)
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidateGroup(c, group)
	c.JSON(http.StatusOK, group)
}

func (s *Server) handleDeleteGroup(c *gin.Context) {
	group, ok := s.groupForRequest(c)
	if !ok {
		return
	}

	if _, err := s.store.DeleteGroup(c.Request.Context(), group.ID); err != nil {
		failStore(c, err)
		return
	}

	s.invalidateGroup(c, group)
	c.Status(http.StatusNoContent)
}

func (s *Server) handleListGroupMembers(c *gin.Context) {
	group, ok := s.groupForRequest(c)
	if !ok {
		return
	}

	members, err := s.store.ListGroupMembers(c.Request.Context(), group.ID)
	if err != nil {
		failStore(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"members": members})
}

func (s *Server) handleAddGroupMembers(c *gin.Context) {
	group, request, ok := s.membershipRequest(c)
	if !ok {
		return
	}

	err := s.store.AddGroupMembers(c.Request.Context(), database.AddGroupMembersParams{
		GroupID: group.ID, UserIds: request.Members, Actor: identityFrom(c).Actor(),
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidateGroup(c, group)
	c.JSON(http.StatusOK, gin.H{"added": len(request.Members)})
}

func (s *Server) handleRemoveGroupMembers(c *gin.Context) {
	group, request, ok := s.membershipRequest(c)
	if !ok {
		return
	}

	removed, err := s.store.RemoveGroupMembers(c.Request.Context(), database.RemoveGroupMembersParams{
		GroupID: group.ID, UserIds: request.Members,
	})
	if err != nil {
		failStore(c, err)
		return
	}

	s.invalidateGroup(c, group)
	c.JSON(http.StatusOK, gin.H{"removed": removed})
}

// membershipRequest loads the group and decodes a member list.
func (s *Server) membershipRequest(c *gin.Context) (database.Group, membersRequest, bool) {
	group, ok := s.groupForRequest(c)
	if !ok {
		return group, membersRequest{}, false
	}

	var request membersRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		failValidation(c, fmt.Errorf("invalid request body: %w", err))
		return group, request, false
	}
	if len(request.Members) == 0 {
		failValidation(c, fmt.Errorf("`members` must list at least one user id"))
		return group, request, false
	}
	return group, request, true
}

// groupForRequest loads the group named in the path, hiding groups in
// environments this key cannot reach.
func (s *Server) groupForRequest(c *gin.Context) (database.Group, bool) {
	id, err := uuid.Parse(c.Param("id"))
	if err != nil {
		failValidation(c, fmt.Errorf("`%s` is not a valid group id", c.Param("id")))
		return database.Group{}, false
	}

	group, err := s.store.GetGroup(c.Request.Context(), id)
	if err != nil {
		failStore(c, err)
		return database.Group{}, false
	}
	if !groupVisibleTo(identityFrom(c), group) {
		fail(c, http.StatusNotFound, codeNotFound, "not found")
		return database.Group{}, false
	}
	return group, true
}

// visibleGroups filters a listing down to what this key may see.
func (s *Server) visibleGroups(c *gin.Context, groups []database.Group) []database.Group {
	identity := identityFrom(c)
	visible := make([]database.Group, 0, len(groups))
	for _, group := range groups {
		if groupVisibleTo(identity, group) {
			visible = append(visible, group)
		}
	}
	return visible
}

// groupVisibleTo reports whether a key may see a group. A group that spans
// every environment is only visible to a key that does too.
func groupVisibleTo(identity Identity, group database.Group) bool {
	if group.Environment == nil {
		return len(identity.Environments) == 0
	}
	return identity.AllowsEnvironment(*group.Environment)
}

// invalidateGroup clears cached resolutions a group change could affect.
func (s *Server) invalidateGroup(c *gin.Context, group database.Group) {
	if group.Environment != nil {
		s.invalidate(c, *group.Environment)
		return
	}
	// A group spanning every environment could have changed any of them.
	environments, err := s.store.ListEnvironments(c.Request.Context())
	if err != nil {
		s.logger.Warn("could not invalidate cache after a group change", "error", err)
		return
	}
	for _, environment := range environments {
		s.invalidate(c, environment.Name)
	}
}
