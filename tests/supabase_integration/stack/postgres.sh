#!/bin/sh
. /harness/common.sh
[ "$#" = 0 ] || fail
[ "$PGDATA" = /var/lib/postgresql/data/pgdata ] || fail
[ "$PGHOST" = /var/lib/grocery-harness/socket ] || fail
[ "$POSTGRES_HOST" = "$PGHOST" ] || fail
[ "$POSTGRES_PORT" = 5432 ] && [ "$POSTGRES_DB" = postgres ] || fail
[ "$POSTGRES_USER" = supabase_admin ] || fail
hex64 "$POSTGRES_PASSWORD"
[ -w "$PGDATA" ] && [ -w "$PGHOST" ] || fail
# Use initdb-created HBA/ident files in PGDATA, not the read-only upstream
# /etc paths. Both temporary initialization and the final server use these.
# A nonempty or interrupted first initialization fails closed.
if [ ! -s "$PGDATA/PG_VERSION" ]; then
    [ -z "$(ls -A "$PGDATA")" ] || fail
else
    [ -f /var/lib/grocery-harness/bootstrap-complete ] || fail
fi
exec /usr/local/bin/docker-entrypoint.sh postgres \
    -D "$PGDATA" -c config_file=/etc/postgresql/postgresql.conf \
    -c data_directory="$PGDATA" -c hba_file="$PGDATA/pg_hba.conf" \
    -c ident_file="$PGDATA/pg_ident.conf" \
    -c unix_socket_directories="$PGHOST" -c listen_addresses='*' \
    -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10 \
    -c logging_collector=off -c archive_mode=off \
    -c shared_memory_type=mmap -c dynamic_shared_memory_type=mmap
