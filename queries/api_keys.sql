-- name: GetApiKeyForAuth :one
-- The hot path: one indexed read on the public prefix. The caller then
-- compares the secret hash in constant time. The role's rank comes along so
-- authorisation needs no second round trip.
select k.id, k.name, k.prefix, k.secret_hash, k.scopes, k.environments,
       k.platforms, k.role, k.is_bootstrap, k.expires_at, k.revoked_at,
       r.rank as role_rank
  from api_keys k
  join roles r on r.name = k.role
 where k.prefix = $1;

-- name: ListApiKeys :many
-- Never selects secret_hash: nothing outside authentication needs it.
select id, name, prefix, scopes, environments, platforms, role, is_bootstrap,
       expires_at, revoked_at, last_used_at, created_at, created_by
  from api_keys
 where @include_revoked::bool or revoked_at is null
 order by created_at desc;

-- name: CreateApiKey :one
insert into api_keys (
  name, prefix, secret_hash, scopes, environments, platforms, role,
  is_bootstrap, expires_at, created_by, updated_by
) values (
  @name, @prefix, @secret_hash, @scopes, @environments, @platforms, @role,
  @is_bootstrap, sqlc.narg('expires_at'), @actor, @actor
)
returning id, name, prefix, scopes, environments, platforms, role,
          is_bootstrap, expires_at, revoked_at, last_used_at, created_at, created_by;

-- name: RevokeApiKey :execrows
-- Revocation is permanent and never removes the row, so an audit of which key
-- did what survives.
update api_keys
   set revoked_at = now(), updated_by = @actor
 where id = @id and revoked_at is null;

-- name: TouchApiKey :exec
-- Records use at most once per throttle window, keeping authentication from
-- turning every read into a write.
update api_keys
   set last_used_at = now()
 where id = @id
   and (last_used_at is null
        or last_used_at < now() - make_interval(secs => @throttle_seconds::int));

-- name: CountApiKeys :one
select count(*) as total from api_keys;
