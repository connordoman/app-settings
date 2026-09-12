-- name: ResolveForUser :many
-- Every setting a user can see, already collapsed to one effective value.
--
-- Precedence, lowest to highest:
--   default_value < server < intermediate (advisory) < personal < intermediate (enforced)
--
-- SERVER-scoped settings come back too: a client needs them to know which
-- features are switched on. The role filter is what keeps a `user` from
-- seeing settings declared for `staff` or `admin`.
with visible as (
  select s.id, s.name, s.description, s.type, s.type_config, s.role,
         s.scope, s.platform, s.environment, s.default_value
    from settings s
    join roles r on r.name = s.role
   where s.environment = @environment
     and (cardinality(@platforms::text[]) = 0 or s.platform = any(@platforms::text[]))
     and r.rank <= @max_rank::int
),
-- Groups the user belongs to, plus any ad-hoc groups named by the caller.
member_groups as (
  select g.id, g.priority, g.created_at
    from groups g
   where (g.environment is null or g.environment = @environment)
     and (
       exists (select 1 from group_members m
                where m.group_id = g.id and m.user_id = @user_id)
       or g.id = any(@ad_hoc_group_ids::uuid[])
     )
),
-- One winning override per setting per direction. Highest group priority
-- wins; the older group breaks a tie so the result is stable.
overrides as (
  select distinct on (i.setting_id, i.is_enforced)
         i.setting_id, i.value, i.visible, i.is_enforced, i.group_id
    from intermediate_settings i
    join member_groups mg on mg.id = i.group_id
   order by i.setting_id, i.is_enforced, mg.priority desc, mg.created_at
)
select
  s.id, s.name, s.description, s.type, s.type_config, s.role, s.scope,
  s.platform, s.environment,

  coalesce(enforced.value, personal.value, advisory.value, server.value, s.default_value) as value,

  case
    when enforced.value  is not null then 'INTERMEDIATE'
    when personal.value  is not null then 'PERSONAL'
    when advisory.value  is not null then 'INTERMEDIATE'
    when server.value    is not null then 'SERVER'
    when s.default_value is not null then 'DEFAULT'
    else 'UNSET'
  end as source,

  -- Both candidate overrides, left joined so an absent one is NULL. Which of
  -- them actually took effect depends on whether the user set a value, and
  -- that last step is clearer in Go than in a nest of CASE expressions.
  enforced.group_id as enforced_group_id,
  enforced.visible  as enforced_visible,
  advisory.group_id as advisory_group_id,
  advisory.visible  as advisory_visible,
  personal.value    as personal_value

from visible s
left join personal_settings personal
       on personal.setting_id = s.id and personal.user_id = @user_id
left join overrides enforced on enforced.setting_id = s.id and enforced.is_enforced
left join overrides advisory on advisory.setting_id = s.id and not advisory.is_enforced
left join server_settings server on server.setting_id = s.id
order by s.name;

-- name: ResolveServer :many
-- The server's own settings: no user, no groups, just the server layer over
-- the declared default.
select
  s.id, s.name, s.description, s.type, s.type_config, s.role, s.scope,
  s.platform, s.environment,
  coalesce(v.value, s.default_value) as value,
  case
    when v.value         is not null then 'SERVER'
    when s.default_value is not null then 'DEFAULT'
    else 'UNSET'
  end as source
  from settings s
  join roles r on r.name = s.role
  left join server_settings v on v.setting_id = s.id
 where s.environment = @environment
   and s.scope = 'SERVER'
   and (cardinality(@platforms::text[]) = 0 or s.platform = any(@platforms::text[]))
   and r.rank <= @max_rank::int
 order by s.name;
