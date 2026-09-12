-- Roles, platforms and environments are all name-keyed lookup tables with the
-- same shape, so the queries below are deliberately parallel.

-- name: ListRoles :many
select * from roles order by rank;

-- name: GetRole :one
select * from roles where name = $1;

-- name: UpsertRole :one
insert into roles (name, description, rank)
values (@name, @description, @rank)
on conflict (name) do update
   set description = excluded.description,
       rank        = excluded.rank
returning *;

-- Refuses to remove a system row; :execrows lets the caller tell "protected"
-- from "absent" by checking whether the row still exists.
-- name: DeleteRole :execrows
delete from roles where name = $1 and not is_system;

-- name: ListPlatforms :many
select * from platforms order by name;

-- name: GetPlatform :one
select * from platforms where name = $1;

-- name: UpsertPlatform :one
insert into platforms (name, description)
values (@name, @description)
on conflict (name) do update set description = excluded.description
returning *;

-- name: DeletePlatform :execrows
delete from platforms where name = $1 and not is_system;

-- name: ListEnvironments :many
select * from environments order by name;

-- name: GetEnvironment :one
select * from environments where name = $1;

-- name: UpsertEnvironment :one
insert into environments (name, description)
values (@name, @description)
on conflict (name) do update set description = excluded.description
returning *;

-- name: DeleteEnvironment :execrows
delete from environments where name = $1 and not is_system;
