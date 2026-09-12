-- Collapse DATE and TIME into a single DATETIME type.
--
-- A DATETIME value is a strict RFC 3339 `date-time`, which requires a UTC
-- offset and therefore names one unambiguous instant. Go normalises every
-- value to UTC before it is stored.
--
-- There is no automatic conversion from the old types, and inventing one would
-- mean inventing data: a DATE has no time of day and a TIME has no date, so
-- neither identifies an instant. Any such settings must be migrated
-- deliberately, so this refuses to run while they exist.

do $$
declare
  stragglers text;
begin
  select string_agg(format('%s (%s/%s)', name, environment, platform), ', ' order by name)
    into stragglers
    from settings
   where type in ('DATE', 'TIME');

  if stragglers is not null then
    raise exception
      'cannot drop the DATE and TIME types while settings still use them: %', stragglers
      using hint = 'Recreate each as a DATETIME with an explicit UTC offset, or delete it, then migrate again.';
  end if;
end;
$$;

-- PostgreSQL cannot remove a value from an enum, so the type is rebuilt.
alter type setting_type rename to setting_type_legacy;

create type setting_type as enum (
  'BOOLEAN', 'NUMBER', 'STRING', 'DATETIME', 'SELECT', 'JSON'
);

alter table settings
  alter column type type setting_type using type::text::setting_type;

drop type setting_type_legacy;

---- create above / drop below ----

alter type setting_type rename to setting_type_current;

create type setting_type as enum (
  'BOOLEAN', 'NUMBER', 'STRING', 'DATE', 'TIME', 'DATETIME', 'SELECT', 'JSON'
);

alter table settings
  alter column type type setting_type using type::text::setting_type;

drop type setting_type_current;
