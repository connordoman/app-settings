-- API keys. A token looks like `sa_<prefix>_<secret>`:
--
--   prefix  12 chars, stored in the clear and uniquely indexed -> O(1) lookup
--   secret  32 CSPRNG bytes, base64url, never stored
--
-- Only sha256(token) is persisted. A slow KDF buys nothing against a 256-bit
-- random secret and would cost a hash on every authenticated request.

create table api_keys (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null check (length(name) between 1 and 255),
  prefix       text        not null unique check (length(prefix) = 12),
  secret_hash  bytea       not null check (length(secret_hash) = 32),

  -- Authorization. Scope names are owned by the application layer.
  scopes       text[]      not null default '{}',
  -- Empty means "every one". Filters keep environments from cross-pollinating.
  environments text[]      not null default '{}',
  platforms    text[]      not null default '{}',
  -- Ceiling on the role a request made with this key may act as.
  role         slug        not null references roles (name) on update cascade,

  -- The single key minted at first boot. CLI access only, cannot be recreated.
  is_bootstrap boolean     not null default false,

  expires_at   timestamptz,
  revoked_at   timestamptz,
  -- Written opportunistically, at most once every few minutes per key.
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  created_by   text        not null,
  updated_at   timestamptz not null default now(),
  updated_by   text        not null
);

-- At most one bootstrap key ever exists.
create unique index api_keys_single_bootstrap on api_keys (is_bootstrap)
  where is_bootstrap;

-- Listing keys hides revoked ones by default.
create index api_keys_active_idx on api_keys (created_at desc)
  where revoked_at is null;

select attach_updated_at('api_keys');

---- create above / drop below ----

drop table if exists api_keys;
