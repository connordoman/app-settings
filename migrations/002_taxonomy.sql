-- User-defined taxonomy: roles, platforms and environments. Rows flagged
-- is_system are seeded here and protected from deletion by the API.

create table roles (
  name        slug        primary key,
  description text        not null default '',
  -- Higher rank sees more. A setting declared for `staff` is visible to every
  -- role whose rank is >= staff's rank.
  rank        integer     not null,
  is_system   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index roles_rank_key on roles (rank);

create table platforms (
  name        slug        primary key,
  description text        not null default '',
  is_system   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table environments (
  name        slug        primary key,
  description text        not null default '',
  is_system   boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

select attach_updated_at('roles');
select attach_updated_at('platforms');
select attach_updated_at('environments');

-- Defaults described in the README. Roles and environments are conveniences the
-- operator may delete; the `server` platform is permanent.
insert into roles (name, description, rank, is_system) values
  ('user',  'End user. Owns personal settings only.',            10, false),
  ('staff', 'Elevated operator. Group and some server settings.', 20, false),
  ('admin', 'Full access to every scope.',                        30, false);

insert into platforms (name, description, is_system) values
  ('server', 'The App Settings server itself. Always present.', true),
  ('web',    'Browser clients.',                                false),
  ('mobile', 'Native mobile clients.',                           false);

insert into environments (name, description, is_system) values
  ('development', 'Local development.', false),
  ('staging',     'Pre-production.',    false),
  ('production',  'Live traffic.',      false);

---- create above / drop below ----

drop table if exists environments;
drop table if exists platforms;
drop table if exists roles;
