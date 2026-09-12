-- name: ListGroups :many
select * from groups
 where (@environment::text = '' or environment = @environment or environment is null)
   and (@include_ephemeral::bool or not is_ephemeral)
 order by priority desc, name;

-- name: GetGroup :one
select * from groups where id = $1;

-- name: CreateGroup :one
insert into groups (name, description, environment, priority, is_ephemeral, created_by, updated_by)
values (@name, @description, sqlc.narg('environment'), @priority, @is_ephemeral, @actor, @actor)
returning *;

-- name: UpdateGroup :one
update groups
   set description = @description,
       priority    = @priority,
       updated_by  = @actor
 where id = @id
returning *;

-- name: DeleteGroup :execrows
delete from groups where id = $1;

-- name: ListGroupMembers :many
select * from group_members where group_id = $1 order by user_id;

-- name: ListGroupsForUser :many
select g.* from groups g
  join group_members m on m.group_id = g.id
 where m.user_id = $1
 order by g.priority desc, g.created_at;

-- name: AddGroupMembers :exec
-- Adds every user in one round trip; re-adding an existing member is a no-op.
insert into group_members (group_id, user_id, created_by)
select @group_id, unnest(@user_ids::text[]), @actor
on conflict (group_id, user_id) do nothing;

-- name: RemoveGroupMembers :execrows
delete from group_members
 where group_id = @group_id and user_id = any(@user_ids::text[]);
