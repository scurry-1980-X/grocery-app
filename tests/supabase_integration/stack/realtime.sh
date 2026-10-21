#!/bin/sh
. /harness/common.sh
[ "$#" = 0 ] || fail
[ "$DB_HOST" = db ] && [ "$DB_PORT" = 5432 ] || fail
[ "$SELF_HOST_TENANT_DB_HOST" = db ] && [ "$SELF_HOST_TENANT_DB_PORT" = 5432 ] || fail
[ "$DB_NAME" = postgres ] && [ "$DB_USER" = supabase_admin ] || fail
hex64 "$DB_PASSWORD"
hex64 "$API_JWT_SECRET"
[ "$RELEASE_TMP" = /var/lib/grocery-harness/release ] || fail
[ "$ERL_CRASH_DUMP" = /var/lib/grocery-harness/erl_crash.dump ] || fail
[ -w "$RELEASE_TMP" ] || fail
case "$RELEASE_COOKIE:$SECRET_KEY_BASE:$DB_ENC_KEY" in *UNRESOLVED*) fail ;; esac
[ "$SEED_SELF_HOST" = true ] || fail
# Upstream seed deletes/recreates a matching tenant. Never reseed after ANY
# attempt, including interruption/uncertain success. New run/volumes required.
# noclobber makes competing attempts fail before native DB initialization.
(set -C; : > /var/lib/grocery-harness/seed-attempted) || fail
/app/bin/migrate
/app/bin/realtime eval 'Realtime.Release.seeds(Realtime.Repo)'
exec /app/bin/server
