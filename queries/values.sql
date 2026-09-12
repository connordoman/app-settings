-- Each layer gets the same three operations. Writes are upserts so that a
-- caller can PUT a value without first checking whether one exists.

-- name: UpsertServerValue :one
insert into server_settings (setting_id, value, created_by, updated_by)
values (@setting_id, @value, @actor, @actor)
on conflict (setting_id) do update
   set value = excluded.value, updated_by = excluded.updated_by
returning *;

-- name: GetServerValue :one
select * from server_settings where setting_id = $1;

-- name: DeleteServerValue :execrows
delete from server_settings where setting_id = $1;

-- name: UpsertPersonalValue :one
insert into personal_settings (user_id, setting_id, value, created_by, updated_by)
values (@user_id, @setting_id, @value, @actor, @actor)
on conflict (user_id, setting_id) do update
   set value = excluded.value, updated_by = excluded.updated_by
returning *;

-- name: GetPersonalValue :one
select * from personal_settings where user_id = @user_id and setting_id = @setting_id;

-- name: ListPersonalValuesForUser :many
select * from personal_settings where user_id = $1;

-- name: DeletePersonalValue :execrows
delete from personal_settings where user_id = @user_id and setting_id = @setting_id;

-- name: UpsertIntermediateValue :one
insert into intermediate_settings (group_id, setting_id, value, visible, is_enforced, created_by, updated_by)
values (@group_id, @setting_id, @value, @visible, @is_enforced, @actor, @actor)
on conflict (group_id, setting_id) do update
   set value       = excluded.value,
       visible     = excluded.visible,
       is_enforced = excluded.is_enforced,
       updated_by  = excluded.updated_by
returning *;

-- name: GetIntermediateValue :one
select * from intermediate_settings where group_id = @group_id and setting_id = @setting_id;

-- name: ListIntermediateValuesForGroup :many
select * from intermediate_settings where group_id = $1;

-- name: DeleteIntermediateValue :execrows
delete from intermediate_settings where group_id = @group_id and setting_id = @setting_id;
