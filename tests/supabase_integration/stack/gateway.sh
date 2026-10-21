#!/bin/sh
. /harness/common.sh
[ "$#" = 0 ] || fail
case "$HARNESS_TENANT" in grocery-*) ;; *) fail ;; esac
nonce=${HARNESS_TENANT#grocery-}
[ "${#nonce}" = 32 ] || fail
case "$nonce" in *[!0-9a-f]*) fail ;; esac
case "$HARNESS_PUBLISHABLE_KEY" in sb_publishable_*) ;; *) fail ;; esac
case "$HARNESS_SECRET_KEY" in sb_secret_*) ;; *) fail ;; esac
hex64 "${HARNESS_PUBLISHABLE_KEY#sb_publishable_}"
hex64 "${HARNESS_SECRET_KEY#sb_secret_}"
# Strict base64url JWT grammar prevents sed/JSON/Lua substitution injection.
for token in "$HARNESS_ANON_JWT" "$HARNESS_SERVICE_JWT"; do
    case "$token" in ''|*[!A-Za-z0-9_.-]*) fail ;; esac
    printf '%s\n' "$token" | grep -Eq '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' || fail
done
[ "$HARNESS_ANON_JWT" != "$HARNESS_SERVICE_JWT" ] || fail
sed -e "s|@PUBLISHABLE_KEY@|$HARNESS_PUBLISHABLE_KEY|g" \
    -e "s|@SECRET_KEY@|$HARNESS_SECRET_KEY|g" \
    -e "s|@ANON_JWT@|$HARNESS_ANON_JWT|g" \
    -e "s|@SERVICE_JWT@|$HARNESS_SERVICE_JWT|g" \
    /harness/gateway.lua > /var/lib/grocery-harness/gateway.lua
sed "s|@TENANT@|$HARNESS_TENANT|g" /harness/gateway.json \
    > /var/lib/grocery-harness/gateway.json
exec /usr/local/bin/envoy -c /var/lib/grocery-harness/gateway.json --disable-hot-restart
