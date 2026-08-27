#!/bin/sh
#
# Write a .env with real secrets in it, so the only thing left to do is `docker compose up -d`.
#
# Four values have no sensible default: three database passwords and the key that encrypts
# everything else. Asking somebody to generate four random strings by hand and paste them
# into the right lines is the whole of this project's setup friction, and it is the kind of
# step people get half-right and then debug for an hour.
#
# POSIX sh and /dev/urandom on purpose. Node is not a dependency of *running* Arlo: the
# README promises Docker and nothing else, so the script that gets you to the first boot
# cannot be the one thing that needs a toolchain.
#
#   ./scripts/setup.sh
#
# Safe to re-run: an existing .env is never overwritten, and any placeholder still left in
# it is filled in. Real values already there are left exactly as they are.
#
# If this cannot run at all (no sh, no /dev/urandom, a locked-down machine), the README has
# a "Doing it by hand" section that is four lines of typing. Nothing here is magic.
set -eu

cd "$(dirname "$0")/.."

TEMPLATE=.env.example
TARGET=.env

[ -f "$TEMPLATE" ] || { echo "No $TEMPLATE here: are you in the repo root?" >&2; exit 1; }

# Hex, so the result is alphanumeric. setup/docker-init.sh seds these into 00-roles.sql and
# a `/` or a quote in one would break it: see the note there.
rand() {
  head -c "${1:-24}" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Carriage returns are the reason this script exists in two versions and still went wrong.
#
# A CRLF checkout (Git for Windows does that by default), or a folder copied off a Windows
# machine gives `.env` lines ending in \r. Compose then reads ARLO_OWNER_PASSWORD=secret\r,
# docker-init.sh seds *that* into 00-roles.sql, and the role ends up with a password the app
# does not send. What you see is `password authentication failed for user "arlo_owner"`,
# which sends you to look at passwords that are, in fact, correct.
#
# .gitattributes now pins the checkout to LF. This is the second line of defence, for a .env
# somebody edited in Notepad or copied from another machine after the fact.
# Byte counts rather than `grep '\r'`: some greps (git-bash's among them) strip carriage
# returns before the pattern ever sees them, so asking whether a CR is present is answered
# "no" on exactly the platform most likely to have put one there.
strip_cr() {
  before=$(wc -c < "$1")
  tmp=$(mktemp)
  tr -d '\r' < "$1" > "$tmp" && mv "$tmp" "$1"
  after=$(wc -c < "$1")
  [ "$before" -ne "$after" ]
}

if [ -f "$TARGET" ]; then
  echo "$TARGET already exists: filling in any placeholders, keeping everything else."
else
  cp "$TEMPLATE" "$TARGET"
  echo "Created $TARGET from $TEMPLATE."
fi

if strip_cr "$TARGET"; then
  echo "Converted $TARGET to Unix line endings: carriage returns would otherwise have ended"
  echo "up inside the passwords, and Postgres would have refused a login that looked correct."
fi

# One value per placeholder, not one per occurrence: ARLO_APP_PASSWORD appears both on its
# own line and inside DATABASE_URL, and the two have to match or nothing connects.
SUPER=$(rand 21)
OWNER=$(rand 21)
APP=$(rand 21)
SECRET=$(rand 32)

swap() {
  # $1 placeholder, $2 replacement. Every occurrence, wherever it appears.
  tmp=$(mktemp)
  sed "s|$1|$2|g" "$TARGET" > "$tmp" && mv "$tmp" "$TARGET"
}

# Named, not counted. "Generated 3 secret(s)" was the whole of the old report, and when the
# fourth silently did not match it said nothing about which one: the failure surfaced much
# later as a Compose error about SECRET_KEY, with no thread back to here.
filled=''
for pair in "CHANGE-ME-SUPER:$SUPER" "CHANGE-ME-OWNER:$OWNER" "CHANGE-ME-APP:$APP"; do
  placeholder=${pair%%:*}
  value=${pair#*:}
  if grep -q "$placeholder" "$TARGET"; then
    swap "$placeholder" "$value"
    filled="$filled $placeholder"
  fi
done

# SECRET_KEY has no placeholder text: it ships blank, which is indistinguishable from
# somebody having cleared it on purpose. Only ever filled when the line is empty, and the
# trailing [[:space:]]* is deliberate: this is the exact match that a stray \r defeated.
if grep -q '^SECRET_KEY=[[:space:]]*$' "$TARGET"; then
  tmp=$(mktemp)
  sed "s|^SECRET_KEY=[[:space:]]*$|SECRET_KEY=$SECRET|" "$TARGET" > "$tmp" && mv "$tmp" "$TARGET"
  filled="$filled SECRET_KEY"
fi

if [ -z "$filled" ]; then
  echo "Nothing to fill in: $TARGET already has its secrets."
else
  echo "Filled in:"
  for name in $filled; do echo "  $name"; done
fi

# Say it plainly rather than leaving it to Compose. Every one of these is required to start,
# and `docker compose up` reports only the first it trips over, as an interpolation error
# several steps removed from the thing that needs fixing.
missing=''
for var in POSTGRES_SUPERUSER_PASSWORD ARLO_OWNER_PASSWORD ARLO_APP_PASSWORD SECRET_KEY; do
  line=$(grep "^$var=" "$TARGET" 2>/dev/null || true)
  value=${line#*=}
  case "$value" in
    '' | CHANGE-ME*) missing="$missing $var" ;;
  esac
done

if [ -n "$missing" ]; then
  echo >&2
  echo "Not ready yet. These still need a value in $TARGET:" >&2
  for name in $missing; do echo "  $name" >&2; done
  echo >&2
  echo "Any random text works: see \"Doing it by hand\" in the README." >&2
  exit 1
fi

cat <<'DONE'

All four secrets are set. Next:

  docker compose up -d

It builds on the first run, so give it a minute. Watch that with:

  docker compose logs -f app

Then open http://127.0.0.1:9005 and sign in with  arlo / arlo
Change that password in Settings straight away: it is published in the README.
DONE
