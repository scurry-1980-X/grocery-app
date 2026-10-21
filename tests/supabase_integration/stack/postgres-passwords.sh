# Sourced by the native PostgreSQL init sequence AFTER bundled migrate.sh.
# Local native-role passwords only. No new roles, grants, app fixtures or SQL
# substitutions. This file is a definition; it has never been executed here.
[ "${POSTGRES_USER:-}" = supabase_admin ] || exit 78
case "${POSTGRES_PASSWORD:-}" in ''|*[!0-9a-f]*) exit 78 ;; esac
[ "${#POSTGRES_PASSWORD}" = 64 ] || exit 78
psql -X --no-password --set=ON_ERROR_STOP=1 --username supabase_admin \
    --dbname postgres --set=harness_password="$POSTGRES_PASSWORD" <<'SQL'
ALTER ROLE authenticator PASSWORD :'harness_password';
ALTER ROLE supabase_auth_admin PASSWORD :'harness_password';
SQL
: > /var/lib/grocery-harness/bootstrap-complete
