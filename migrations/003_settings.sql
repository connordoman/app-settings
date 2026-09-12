-- The setting *definition*: what a setting means, who may see it, where it
-- applies. Values live in separate per-layer tables (migration 005).

create type setting_scope as enum ('PERSONAL', 'INTERMEDIATE', 'SERVER');

comment on type setting_scope is
  'Highest layer allowed to hold a value. PERSONAL permits server+group+user layers, INTERMEDIATE permits server+group, SERVER permits server only.';

create type setting_type as enum (
  'BOOLEAN', 'NUMBER', 'STRING', 'DATE', 'TIME', 'DATETIME', 'SELECT', 'JSON'
);

create table settings (
  id            uuid          primary key default gen_random_uuid(),
  name          slug          not null,
  description   text          not null default '',
  type          setting_type  not null,
  -- Type-specific rules validated in Go: SELECT options, NUMBER bounds,
  -- STRING patterns, and the timezone policy for DATE/TIME/DATETIME.
  type_config   jsonb         not null default '{}'::jsonb,
  role          slug          not null references roles (name) on update cascade,
  scope         setting_scope not null,
  platform      slug          not null references platforms (name) on update cascade,
  environment   slug          not null references environments (name) on update cascade,
  -- Out-of-box value used when no layer supplies one. Part of the definition,
  -- as distinct from an operator's server-layer override.
  default_value jsonb,
  created_at    timestamptz   not null default now(),
  created_by    text          not null,
  updated_at    timestamptz   not null default now(),
  updated_by    text          not null,

  constraint settings_name_unique_per_target unique (name, platform, environment),
  constraint settings_type_config_is_object check (jsonb_typeof(type_config) = 'object')
);

-- Every read path filters on platform+environment and orders by name.
create index settings_target_idx on settings (environment, platform, name);
create index settings_role_idx on settings (role);

select attach_updated_at('settings');

---- create above / drop below ----

drop table if exists settings;
drop type if exists setting_type;
drop type if exists setting_scope;
