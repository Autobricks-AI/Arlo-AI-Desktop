-- Two roles, the schema, and pgvector. Run once, as an administrator, before the first
-- migration.
--
--   Docker:  setup/docker-init.sh runs this for you on the first boot of a fresh volume.
--   By hand: psql -U postgres -d arlo -f setup/00-roles.sql
--
-- Replace the two passwords below first, or let scripts/setup.sh generate them.
--
--   arlo_owner  owns the schema and runs migrations.
--   arlo_app    what the application connects as. NOBYPASSRLS, so the row-level security
--               policies in the migrations always apply to it.
--
-- Not in migrations/ because the migration runner connects as arlo_owner, which cannot
-- create roles or extensions.

-- 1. The roles. Change these passwords.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'arlo_owner') then
    create role arlo_owner login password 'CHANGE-ME-OWNER' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'arlo_app') then
    create role arlo_app login password 'CHANGE-ME-APP' nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;

-- Belt and braces if this file is re-run. nosuperuser/nobypassrls are deliberately NOT
-- repeated: Postgres requires superuser to so much as mention either in ALTER ROLE, even to
-- turn it off. Both are the CREATE ROLE default and are set explicitly above; step 5 proves it.
alter role arlo_app   nocreatedb nocreaterole;
alter role arlo_owner nocreatedb nocreaterole;

-- 2. pgvector. Creating an extension needs more rights than the migration runner has.
create extension if not exists vector;

-- 3. Our own schema, owned by the role that will create the tables in it.
--
-- `authorization arlo_owner` needs SET ROLE on it, and the automatic membership a new role
-- grants its creator carries neither SET nor INHERIT by default. Take it explicitly.
grant arlo_owner to current_user;
grant arlo_app to current_user;

create schema if not exists arlo authorization arlo_owner;
grant usage on schema arlo to arlo_app;

-- The test harness isolates files by creating one schema per test file and dropping it
-- afterwards, so the owner needs to be able to create further schemas. A database that
-- never runs the suite can revoke this once the arlo schema exists.
do $$ begin execute format('grant create on database %I to arlo_owner', current_database()); end $$;

-- The vector type lands in whichever schema the extension chose (public, normally), so both
-- roles need to see it from the arlo schema.
grant usage on schema public to arlo_owner, arlo_app;

-- 4. Keep the app out of the platform's schema beyond that read.
revoke create on schema public from arlo_app;

-- 5. Prove it worked. Both roles must read `f` in both columns, or RLS is not enforced.
select rolname, rolsuper as is_superuser, rolbypassrls as bypasses_rls
  from pg_roles where rolname in ('arlo_app', 'arlo_owner');
