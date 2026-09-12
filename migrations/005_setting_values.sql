-- One table per layer. Resolution order, lowest to highest precedence:
--
--   settings.default_value
--     < server_settings
--       < intermediate_settings (advisory)
--         < personal_settings
--           < intermediate_settings (enforced)
--
-- That ordering is what makes the intermediate layer bidirectional: an
-- advisory group value behaves as a group-wide default the user may replace,
-- an enforced one overrules whatever the user chose.

-- Rejects a value written to a layer the setting's scope does not permit.
-- Called as a trigger with the layer name as its first argument.
create function assert_layer_allowed() returns trigger
  language plpgsql as $$
declare
  layer          text := tg_argv[0];
  declared_scope setting_scope;
  allowed        boolean;
begin
  select s.scope into declared_scope from settings s where s.id = new.setting_id;

  allowed := coalesce(case layer
    when 'server'       then true
    when 'intermediate' then declared_scope in ('INTERMEDIATE', 'PERSONAL')
    when 'personal'     then declared_scope = 'PERSONAL'
    else false
  end, false);

  if not allowed then
    raise exception 'setting % is scoped % and cannot hold a % value',
      new.setting_id, declared_scope, layer
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- A group restricted to one environment may only override settings in it.
create function assert_group_environment_matches() returns trigger
  language plpgsql as $$
declare
  mismatch boolean;
begin
  select g.environment is not null and g.environment is distinct from s.environment
    into mismatch
    from groups g, settings s
   where g.id = new.group_id and s.id = new.setting_id;

  if mismatch then
    raise exception 'group % and setting % belong to different environments',
      new.group_id, new.setting_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create table server_settings (
  id         uuid        primary key default gen_random_uuid(),
  setting_id uuid        not null unique references settings (id) on delete cascade,
  value      jsonb       not null,
  created_at timestamptz not null default now(),
  created_by text        not null,
  updated_at timestamptz not null default now(),
  updated_by text        not null
);

create table intermediate_settings (
  id          uuid        primary key default gen_random_uuid(),
  group_id    uuid        not null references groups (id) on delete cascade,
  setting_id  uuid        not null references settings (id) on delete cascade,
  value       jsonb       not null,
  -- Does the user get told their setting was overridden?
  visible     boolean     not null default true,
  -- Enforced overrides beat the user's own value; advisory ones yield to it.
  is_enforced boolean     not null default false,
  created_at  timestamptz not null default now(),
  created_by  text        not null,
  updated_at  timestamptz not null default now(),
  updated_by  text        not null,

  constraint intermediate_settings_one_per_group unique (group_id, setting_id)
);

create table personal_settings (
  id         uuid        primary key default gen_random_uuid(),
  user_id    text        not null check (length(user_id) between 1 and 255),
  setting_id uuid        not null references settings (id) on delete cascade,
  value      jsonb       not null,
  created_at timestamptz not null default now(),
  created_by text        not null,
  updated_at timestamptz not null default now(),
  updated_by text        not null,

  constraint personal_settings_one_per_user unique (user_id, setting_id)
);

-- Resolving one user means fetching every personal row for that user, and
-- every group row for the groups they belong to.
create index personal_settings_user_idx on personal_settings (user_id);
create index intermediate_settings_setting_idx on intermediate_settings (setting_id);

create trigger assert_layer before insert or update on server_settings
  for each row execute function assert_layer_allowed('server');
create trigger assert_layer before insert or update on intermediate_settings
  for each row execute function assert_layer_allowed('intermediate');
create trigger assert_layer before insert or update on personal_settings
  for each row execute function assert_layer_allowed('personal');

create trigger assert_group_environment before insert or update on intermediate_settings
  for each row execute function assert_group_environment_matches();

select attach_updated_at('server_settings');
select attach_updated_at('intermediate_settings');
select attach_updated_at('personal_settings');

---- create above / drop below ----

drop table if exists personal_settings;
drop table if exists intermediate_settings;
drop table if exists server_settings;
drop function if exists assert_group_environment_matches();
drop function if exists assert_layer_allowed();
