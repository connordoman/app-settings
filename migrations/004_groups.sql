-- Groups carry the intermediate layer. A group may be saved for reuse or
-- created ad-hoc; ad-hoc groups are ordinary rows flagged is_ephemeral so
-- operators can prune them.

create table groups (
  id           uuid        primary key default gen_random_uuid(),
  name         slug        not null,
  description  text        not null default '',
  -- Null scopes the group to every environment.
  environment  slug        references environments (name) on update cascade,
  -- Ordering when a user belongs to several groups that override the same
  -- setting. Higher wins; ties break on the older group.
  priority     integer     not null default 0,
  is_ephemeral boolean     not null default false,
  created_at   timestamptz not null default now(),
  created_by   text        not null,
  updated_at   timestamptz not null default now(),
  updated_by   text        not null,

  constraint groups_name_unique_per_environment unique (name, environment)
);

create table group_members (
  group_id   uuid        not null references groups (id) on delete cascade,
  -- Opaque identifier owned by the caller's own user system.
  user_id    text        not null check (length(user_id) between 1 and 255),
  created_at timestamptz not null default now(),
  created_by text        not null,

  primary key (group_id, user_id)
);

-- Resolution starts from "which groups is this user in?".
create index group_members_user_idx on group_members (user_id);

select attach_updated_at('groups');

---- create above / drop below ----

drop table if exists group_members;
drop table if exists groups;
