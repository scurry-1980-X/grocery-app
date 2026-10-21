# Disposable Supabase integration harness — Tasks #1, #2, #3A and #3B

**Offline configuration only. No service startup, database connections, SQL
execution, cleanup implementation or deployment. Migration 003 remains NO-GO for
production.** Task #2 builds on `codex/isolated-restore-verification` at
`fdc03783253d0fe2d34255ae061568002fc2d694`. The reviewed baseline under
[`fixtures/`](fixtures/README.md) is unchanged and is not loaded by this harness.

**Current gate — Task #4A:** [build-preflight evidence and findings](preflight/README.md)
verify six pinned image configuration blobs and a reproducible 15-file context
snapshot. Read-only inspection reports an amd64 local default builder, but
independent daemon binding and exclusive cache/GC ownership remain unproven.
**NO-GO for Task #4B builds in the inspected environment.** No build/runtime
executor was added; all earlier guards and stack definitions are unchanged.
`support/build_preflight.py` and `tests/test_supabase_build_preflight.py` provide
offline evidence/context/output-identity checks only. Historical recommendations
below describe their respective task checkpoints; this current gate takes priority.

## What exists

- `scripts/run_supabase_integration.py`: only `preflight` and `--help` are
  supported. All other arguments/actions are rejected with redacted errors.
- `support/safety.py`: pure offline validation of safety-policy records and
  resource identities. These are strict in-memory contracts, **not** Docker or
  Compose configuration and **not** verified daemon observations.
- `tests/test_supabase_integration_safety.py`: positive and negative tests with
  synthetic policies; DNS, socket and process creation are forbidden in the
  entry-point test. Existing fixture provenance tests remain separate.

- `support/stack.py`: in-memory generation and whole-document validation of a
  six-service Compose definition, followed by the unchanged Task #1 policy checks.
  Task #3B verifies the preserved registry evidence, literal amd64 Dockerfile pins,
  exact Realtime source bytes and build-context allowlist before producing a plan.
  No caller-supplied URLs, credentials, image names, digests or overrides are accepted.
- `stack/`: six digest-pinned derived-image definitions, startup/path adapters,
  gateway configuration, and [provenance/deviations](stack/PROVENANCE.md).
- `tests/test_supabase_integration_stack.py`: offline definition and mutation tests.
- `tests/test_supabase_gateway.py`: the actual gateway Lua filter exercised with
  in-memory Envoy stubs. Requires an already-installed liblua 5.3 or 5.4; it fails
  explicitly if unavailable, rather than silently skipping the key-behavior tests.

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
   image/build/command fields—remain rejected by this safety projection. Task #2
   separately validates the entire generated Compose document before checking
   the projection; it does not strip unknown settings into a safe-looking record.
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

Task #2 now defines PostgreSQL, Auth, PostgREST, Realtime, Envoy and Mailpit.
It does not build or run them. All six services have explicit non-root users,
read-only root filesystems, dropped capabilities and no-new-privileges. One
nonce-owned internal bridge and five nonce-owned named volumes are defined.
Only `/var/lib/postgresql/data` and `/var/lib/grocery-harness` may be mounted;
Auth and PostgREST have no writable volume. No host ports, bind mounts or external
services are defined. Existing local containers/volumes must not be reused.

The full Compose definition is generated in memory with fresh run names/labels;
there is intentionally no reusable checked-in Compose run file or export CLI.
`create_plan(environment)` rejects ambient configuration, produces only invalid
credential placeholders, and validates the whole result. It never forwards the
supplied environment. Tests are the supported way to exercise this API in Task #2.
The existing CLI still accepts only `preflight` and `--help`.

Runtime stays blocked: all Compose entrypoints point to an absent blocker path,
healthchecks are disabled, derived images cannot be pulled, credential slots
remain invalid placeholders, and `require_runtime_ready` always rejects.
No runtime-enable flag or secret-generation path exists. See
[the complete design and limitations](stack/PROVENANCE.md)
for all adaptations, native bootstrap prerequisites and source evidence.

**Task #3A provenance recovered:** the exact pinned upstream
`docker/volumes/db/realtime.sql`, all six OCI indexes, and all twelve Linux
amd64/arm64 manifest identities are verified. Raw evidence and the distinction
between index, platform, config and source hashes are documented in
[the source review](stack/SOURCE_REVIEW_3A.md). The recovered SQL remains the exact
reviewed source;
Task #3B now copies it unchanged in the PostgreSQL build definition, but no image
has been built and the SQL has not been executed. All runtime execution blockers
remain in force.

**Task #3B integration:** all Dockerfiles use literal verified `linux/amd64`
child-manifest pins, with no build arguments. The shared build context includes
the exact SQL; only the PostgreSQL Dockerfile copies it to native
`migrations/99-realtime.sql`, with a
future build-time destination-collision check and SHA-256 verification. Its psql
processing stays with the native bootstrap chain; no shell adapter executes it
separately. The generator hashes the nested evidence inputs as well as checking
those identities. Task #1 safety contracts are unchanged.

A separately authorized **build-only** task is the next gate. Before building,
it must inspect base-image configs/ONBUILD/defaults, validate the local builder,
architecture and exact context snapshot, and define owned output/cache inventory.
It must retain offline RUN steps and prohibit service startup, database bootstrap,
SQL execution and global cleanup. There is no executor or build authorization in
this harness. A build is not a harmless metadata read: it executes Dockerfile RUN
steps and may create temporary builder containers.

GO to commit the disabled Task #3B definitions. Conditional GO to a separately
reviewed build-only task that completes those preflight gates and stops on any
incompatibility. Runtime is still NO-GO: native bootstrap parity, protected local
credentials, readiness, ownership journaling, isolation probes and exact-inventory
teardown remain unimplemented or unverified.

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
