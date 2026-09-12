-- name: ListSettings :many
-- Filters are optional: pass an empty string or empty array to ignore one.
select s.*
  from settings s
  join roles r on r.name = s.role
 where (@environment::text = '' or s.environment = @environment)
   and (@platform::text = '' or s.platform = @platform)
   and (@scope::text = '' or s.scope = @scope::setting_scope)
   and r.rank <= @max_rank::int
 order by s.environment, s.platform, s.name;

-- name: GetSetting :one
select * from settings where id = $1;

-- name: GetSettingByName :one
select * from settings
 where name = @name and platform = @platform and environment = @environment;

-- name: CreateSetting :one
insert into settings (
  name, description, type, type_config, role, scope, platform, environment,
  default_value, created_by, updated_by
) values (
  @name, @description, @type, @type_config, @role, @scope, @platform, @environment,
  @default_value, @actor, @actor
)
returning *;

-- name: UpdateSetting :one
-- Only description, type_config, role and default_value may change. A
-- setting's type, scope and target are structural: changing them would
-- invalidate values already stored against it.
update settings
   set description   = @description,
       type_config   = @type_config,
       role          = @role,
       default_value = @default_value,
       updated_by    = @actor
 where id = @id
returning *;

-- name: DeleteSetting :execrows
delete from settings where id = $1;

-- name: CountSettingValues :one
-- How many values would be destroyed along with this setting.
select (select count(*) from personal_settings     p where p.setting_id = @setting_id)
     + (select count(*) from intermediate_settings i where i.setting_id = @setting_id)
     + (select count(*) from server_settings       v where v.setting_id = @setting_id) as total;
