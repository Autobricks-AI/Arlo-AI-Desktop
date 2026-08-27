#!/bin/sh
#
# Role setup, run once by Postgres itself on a fresh data volume.
#
# The official image executes everything in /docker-entrypoint-initdb.d on first boot only,
# which is exactly the "run ONCE, before the first migration, as an administrator" contract
# 00-roles.sql already documents. Mounting it here is what removes the manual step.
#
# It has to be a shell script rather than the .sql directly, because the passwords must come
# from the environment: a .sql file in that directory is handed straight to psql with no
# expansion, so the CHANGE-ME placeholders would land in the database verbatim. The .sql
# stays the single source of truth for *what* the roles are; this only fills in the two
# secrets.
#
# Never mount 00-roles.sql into /docker-entrypoint-initdb.d as well. Files there run in
# alphabetical order, and the raw one would create both roles with the literal placeholder
# passwords before this script ever ran.
set -eu

: "${ARLO_OWNER_PASSWORD:?set it in .env}"
: "${ARLO_APP_PASSWORD:?set it in .env}"

# Carriage returns, stripped before they can become part of a password.
#
# A `.env` with CRLF line endings (a Windows checkout, or a folder copied off one), gives
# Compose ARLO_OWNER_PASSWORD=secret\r. Without this the role is created *with* that \r and
# the app connects without one, so the first thing anybody sees is
# `password authentication failed for user "arlo_owner"` against a password that looks
# exactly right in .env. This runs once, on a fresh volume, and getting it wrong here means
# `docker compose down -v` to fix it, so it is worth two lines to make impossible.
OWNER=$(printf '%s' "$ARLO_OWNER_PASSWORD" | tr -d '\r\n')
APP=$(printf '%s' "$ARLO_APP_PASSWORD" | tr -d '\r\n')

# Refuse rather than mangle. These are substituted with sed and then quoted into SQL, so a
# `/`, a backslash or a quote is either a broken script or a broken role, and both fail
# later, somewhere less obvious than here.
# Loud on purpose. Whatever is printed here is the only explanation anybody gets: Compose
# reports `container ... is unhealthy` and nothing else, and the app's logs: where people
# look first: are empty, because the app never started.
refuse() {
  echo '' >&2
  echo '================================================================' >&2
  echo ' ARLO SETUP FAILED: the database was not initialised' >&2
  echo '' >&2
  echo "  $1" >&2
  echo '' >&2
  echo ' Fix .env, then throw the half-made volume away and try again:' >&2
  echo '' >&2
  echo '   docker compose down -v' >&2
  echo '   docker compose up -d' >&2
  echo '' >&2
  echo ' A restart on its own will NOT help: this script runs once, on the' >&2
  echo ' first boot of an empty volume.' >&2
  echo '================================================================' >&2
  echo '' >&2
  exit 1
}

for p in "$OWNER" "$APP"; do
  case "$p" in
    '')
      refuse "A database password is empty. Set it in .env: see the README." ;;
    */* | *\\* | *\'* | *\"* | *\&*)
      refuse "A database password contains one of  / \\ ' \" & : these are substituted into SQL here and cannot be escaped safely. Use letters and digits." ;;
  esac
done

sed -e "s/CHANGE-ME-OWNER/${OWNER}/" \
    -e "s/CHANGE-ME-APP/${APP}/" \
    /opt/arlo-setup/00-roles.sql |
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB"
