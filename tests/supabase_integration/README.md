# Disposable Supabase integration harness — Task #1

**Offline skeleton only. No stack, services, database connections, SQL execution,
cleanup implementation or deployment. Migration 003 remains NO-GO for production.**
Based on `codex/isolated-restore-verification` at
`86e0caca2d5cb27bc2644e042d28ae6db2a5bfd3`. The reviewed baseline under
[`fixtures/`](fixtures/README.md) is unchanged and is not loaded by this harness.

## What exists

- `scripts/run_supabase_integration.py`: only `preflight` and `--help` are
  supported. All other arguments/actions are rejected with redacted errors.
- `support/safety.py`: pure offline validation of safety-policy records and
  resource identities. These are strict in-memory contracts, **not** Docker or
  Compose configuration and **not** verified daemon observations.
- `tests/test_supabase_integration_safety.py`: positive and negative tests with
  synthetic policies; DNS, socket and process creation are forbidden in the
  entry-point test. Existing fixture provenance tests remain separate.

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python scripts/run_supabase_integration.py --help
PYTHONDONTWRITEBYTECODE=1 python scripts/run_supabase_integration.py preflight
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_*.py' -v
```

Preflight rejects an inherited connection/credential environment. Do not supply
real project configuration. A successful report says
`OFFLINE_ONLY_RUNTIME_DISABLED`, generates a fresh non-secret run identity and
shows an example resource name/labels. It explicitly reports that Docker is
**not verified**, no resources were created and runtime execution is disabled.
It writes no run journal, credentials, configuration or other artifacts.

## Safety contracts

1. **No external configuration input.** No database URL, Supabase URL, project
   reference, credential, config path, context override or run-ID option exists.
   Arguments fail before environment inspection or identity generation. Errors
   do not echo arguments, environment variable names or values.
2. **No inherited application configuration.** Environment selectors for
   PostgreSQL, Supabase, Docker/Compose, other container/cloud tools, URLs,
   tokens, passwords and secrets fail even when empty. Recognizable hosted
   Supabase addresses, URI schemes, Supabase keys and JWT forms under renamed
   keys also fail. Unrecognized ambient variables and standard proxy variables
   are ignored, never consumed or forwarded; no child/executor exists. This is
   not a universal secret detector. Arbitrary opaque text cannot be identified
   as a credential, so the safety boundary is the absence of external credential
   inputs or ambient forwarding, not pattern matching alone.
3. **No hostname resolution.** The only reserved API origin is the literal
   `http://127.0.0.1:54321`, intended inside a future isolated test namespace.
   Hostnames (including localhost), alternate numeric spellings, userinfo,
   different ports, paths, query strings and fragments fail exact comparison.
   This is not authorization to connect to host loopback. No origin is consumed
   by the current preflight.
4. **Local Docker contract only.** A minimal context projection must identify
   `default`, exactly `unix:///var/run/docker.sock`, and no TLS bypass. Remote,
   TCP/SSH, alternate sockets, unknown or missing fields fail. Nothing queries
   Docker or reads the user's Docker context/configuration at this stage.
5. **Strict resource policies.** A future network must be a run-owned internal
   bridge, not external/attachable, with no driver options. Volumes must be
   run-owned local volumes without external flags or driver options (including
   bind/NFS options). Containers must use that network, a non-root numeric
   UID/GID (each 1–2147483647), read-only root filesystem, dropped capabilities and
   no-new-privileges. No privileged mode, host/shared namespace overrides,
   added capabilities, unconfined security options, host ports, devices,
   custom DNS/hosts/sysctls or restart behavior is accepted.
6. **No host mounts.** Only validated run-owned named volumes at the two
   explicitly reserved data paths are allowed. Bind mounts, sockets, host paths,
   propagation settings, unexpected/duplicate targets and foreign volumes fail.
   Unknown container fields—including environment, secrets, Compose overrides,
   image/build/command fields—are unsupported and rejected by this safety
   projection. These are not yet full container specifications.
7. **Run ownership.** A cryptographically random 128-bit nonce is generated once
   per preflight. Resource names and labels encode the exact nonce, owner, kind
   and component. Prefix matches alone never establish ownership. Future
   persistence/recovery must preserve this identity; it is not a secret.
8. **Cleanup checks only.** `cleanup_candidates` requires matching recorded and
   observed inventories: exact names/labels/kinds and full container/network IDs
   or exact volume names. Missing, duplicate, foreign or changed records fail.
   It returns identifiers only. There is no deletion command, global search,
   prune, automatic cleanup, or reuse of historical restore containers.

## Later stages and remaining enforcement gaps

A later authorized task must provide a reviewed, pinned native Supabase stack
(Auth, PostgREST, PostgreSQL/RLS/RPC and Realtime), generated per-run credentials,
a protected ownership journal, real daemon/context/resource inspection, and
isolated creation/teardown. Existing local containers/volumes are unrelated and
must not be reused. The current restrictive policy has **not** been proved
compatible with official images; any required exceptions need explicit review.

The future executor must validate the full effective configuration, not silently
filter dangerous settings into a safe-looking projection. It must start from a
controlled environment/configuration, reject override files and inherited
credentials, and obtain fresh observations itself. A local socket string does
not prove that its daemon is local/trusted. Offline records cannot prove actual
mounts, capabilities, network attachments, egress denial or ownership.

Labels can be forged. Journal integrity, daemon binding, resource-ID matching
and immediate reinspection before destructive actions remain runtime duties.
Volume names have no independent immutable Docker ID; name recreation and
inspection/action races need runtime handling. No cleanup authorization is
provided by a successful offline check alone.

The fixed API origin must live inside the future test namespace with no host
port publishing, enforced egress denial and redirect rejection. Loopback alone
could reach unrelated host services if used outside that namespace. Browser
routing, DNS/redirect/WebSocket behavior, foreign-token rejection by real Auth,
private credential lifecycle, and isolation probes are later integration gates.

Only after those gates may separately authorized stages install 001 then 002,
compare resulting application catalogs to the historical evidence, and exercise
Migration 003 and the recovered client. Realtime setup stays separate. This task
neither runs those stages nor establishes production readiness.
