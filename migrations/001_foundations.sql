-- Shared building blocks used by every later migration: a slug domain for
-- user-defined taxonomy names, and an updated_at trigger so application code
-- never has to remember to touch the column.

create domain slug as text
  check (value ~ '^[a-z0-9][a-z0-9_.-]{0,62}$');

comment on domain slug is
  'Lowercase identifier safe for URLs and config files: 1-63 chars of [a-z0-9_.-], not starting with punctuation.';

create function set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with the current transaction time.';

-- Attaches the standard updated_at trigger to a table. Keeps the boilerplate
-- in one place so adding an audited table is a single line.
create function attach_updated_at(target regclass) returns void
  language plpgsql as $$
begin
  execute format(
    'create trigger set_updated_at before update on %s
       for each row execute function set_updated_at()',
    target
  );
end;
$$;

---- create above / drop below ----

drop function if exists attach_updated_at(regclass);
drop function if exists set_updated_at();
drop domain if exists slug;
