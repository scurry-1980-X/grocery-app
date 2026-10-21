# Disabled stack definitions: Tasks #2, #3A and #3B

**Configuration only; no image has been pulled, built or run.** Task #2 started at
`fdc03783253d0fe2d34255ae061568002fc2d694`. Baseline fixtures and Task #1 guards are
unchanged. `provenance.json` records their SHA-256 hashes, the image candidates,
full upstream source commits, exact source URLs and the original 32 cached-source
hashes. Those hashes were rechecked locally during Task #2, which made no network
requests. Task #3A adds an independently recovered Realtime source and verified
registry manifest evidence from authorized read-only research; see
[SOURCE_REVIEW_3A.md](SOURCE_REVIEW_3A.md). The earlier authorized review compared
seven core source files at their version tags and full commits; all seven matched.

The upstream source cache was read from `/tmp/grocery-upstream-source-review`.
The earlier cache is not a repository dependency and is not vendored here. Task
#3A preserves the recovered SQL and registry response bodies under `evidence/`.
Source hashes are distinct from OCI digests. All six index digests and twelve
Linux amd64/arm64 manifest digests are now verified in provenance metadata. Task
#3B integrates the verified amd64 child digests as literal
Dockerfile FROM references and accepts no build arguments. Runtime execution is
still rejected. It targets `linux/amd64`; native ARM64 runtime support and any
emulation remain unverified. Tags must not be assumed immutable.

## Version/source inventory

The version cohort is the official Supabase
[Compose snapshot](https://github.com/supabase/supabase/blob/e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7/docker/docker-compose.yml).
It is evidence of upstream composition, not evidence that this restricted stack
runs successfully.

| Service / base image | Pinned source | Harness definition |
| --- | --- | --- |
| `supabase/postgres:17.6.1.136` | [Dockerfile-17](https://github.com/supabase/postgres/blob/d156ba65c14694c12cc5e782bc15b9b8ed2d1376/Dockerfile-17) | `Dockerfile.db`, `postgres.sh`, `postgres-passwords.sh` |
| `supabase/gotrue:v2.197.0` | [Dockerfile](https://github.com/supabase/auth/blob/4eee58f296d9698a1c2c0ae14d7a0b379c7622d3/Dockerfile) | `Dockerfile.auth` |
| `postgrest/postgrest:v14.18` | [Dockerfile](https://github.com/PostgREST/postgrest/blob/6fafa601d13b15f9875e3a70e733ddd6f38f633e/Dockerfile), [Nix image definition](https://github.com/PostgREST/postgrest/blob/6fafa601d13b15f9875e3a70e733ddd6f38f633e/nix/tools/docker/default.nix) | `Dockerfile.rest` |
| `supabase/realtime:v2.143.3` | [Dockerfile](https://github.com/supabase/realtime/blob/d46540b3a4a79113f40301d5e5cb690f41150b9b/Dockerfile), [startup](https://github.com/supabase/realtime/blob/d46540b3a4a79113f40301d5e5cb690f41150b9b/run.sh) | `Dockerfile.realtime`, `realtime.sh` |
| `envoyproxy/envoy:v1.39.4` | [Dockerfile](https://github.com/envoyproxy/envoy/blob/72315c132d462e5126e492ab2a71057565dbc87a/distribution/docker/Dockerfile-envoy) | `Dockerfile.gateway`, `gateway.sh`, `gateway.json`, `gateway.lua` |
| `axllent/mailpit:v1.31.6` | [Dockerfile](https://github.com/axllent/mailpit/blob/a028b01f4a24b4b36bdad95b8e09e070ebf2bad4/Dockerfile), [SQLite storage](https://github.com/axllent/mailpit/blob/a028b01f4a24b4b36bdad95b8e09e070ebf2bad4/internal/storage/database.go) | `Dockerfile.mail` |

Envoy 1.39.4 deliberately replaces 1.39.1 in the reference Compose file, following
the completed compatibility review. Combined compatibility remains untested.
PostgreSQL's image tag is not a claim of PostgreSQL 17.11 binary fidelity.

## Adaptations and evidence

### Common isolation and build delivery

`support/stack.py` generates a full JSON-compatible Compose document in memory.
There is no checked-in reusable run nonce or serialized Compose file. There is
also no export, build, start or cleanup CLI. Task #1's `preflight` is unchanged.
The document includes safety records and hashes of the stack definition files.
The full document is checked against the trusted generator, with type-sensitive
comparison, before those safety records are passed to Task #1's validators.
Unknown fields or altered images, credentials, networks, mounts, commands,
build contexts, paths or labels fail, even when the accompanying safety projection
has been left unchanged. Source code/reviewed repository integrity is the trust
boundary; this is not a sandbox against someone who can modify the generator.

Four derived images prepare allowed volume paths at build time. Build-time root
is used only for files/user/group preparation; every final runtime user is numeric
and non-root. Auth and PostgREST need only explicit entrypoints and UID:GID. No
runtime root init container, ownership repair, capability, bind mount, tmpfs or
Docker socket is added. Build definitions use no package installation, downloads
or network-dependent RUN commands; generated build networking is `none`.
Pulling base images and executing build steps still require separate authorization.
Task #3B changes only FROM identities, the PostgreSQL source-copy/hash checks, the
context allowlist and offline validation. Existing runtime users and settings stay
unchanged.

Docker's [volume documentation](https://github.com/docker/docs/blob/main/content/manuals/engine/storage/volumes.md)
describes population of an empty volume from the image directory. The definitions
rely on that behavior (`nocopy: false`) for preowned directories. Copy-up ownership
and permissions remain a runtime verification gate. No existing volumes may be
reused. Automatic image-declared anonymous volumes, image default environment,
ONBUILD directives and extra image capabilities must also be inspected before
runtime approval; source Dockerfiles alone do not verify the published image.

### PostgreSQL and native platform bootstrap

The [native entrypoint](https://github.com/docker-library/postgres/blob/6edb0a8c4def40c371514b34aef9037ec82d9110/17/alpine3.23/docker-entrypoint.sh)
initializes a database as an existing non-root passwd identity. The derived image
assigns the existing postgres OS account UID:GID 10001:10001 at build time.
PGDATA is a child of the allowed data-volume mount so its ownership can be
populated from the image. Socket, home, temporary and pgsodium key paths are in a
separate allowed runtime volume. A build-time symlink redirects the native
pgsodium key-file path without changing its key-generation algorithm.

`postgres.sh` invokes the native entrypoint and keeps its bundled native platform
SQL/migration chain. It points HBA/ident settings at initdb-created files in
PGDATA, rather than the image's `/etc` files, and uses the same socket settings
for initialization and the final server. This is a deliberate local connection
configuration change, not a claim of byte-identical upstream pg_hba.conf.
Logging goes to container output; archiving is disabled. Logical WAL and
replication slots support later Realtime tests. PostgreSQL shared-memory files
use mmap-backed data-directory storage instead of adding `/dev/shm` mounts.
Unknown additional native writes must fail against the read-only rootfs.

`postgres-passwords.sh` is a non-executable, sourced final native init hook.
It defines local password initialization for the existing `authenticator` and
`supabase_auth_admin` roles. It defines no new Auth roles/functions and changes no
grants, RLS or application permissions. Passwords are unresolved slots today;
a future executor must generate and protect them. The definition contains SQL;
**none of it has been executed**. An end marker prevents restarting an
incompletely bootstrapped data directory. A failed/uncertain initialization needs
a new owned run, not repair of an unverified database.

**Task #3A recovered the source; Task #3B integrates its exact bytes.** The exact
[`docker/volumes/db/realtime.sql` at the pinned Supabase commit](https://github.com/supabase/supabase/blob/e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7/docker/volumes/db/realtime.sql)
is retained unchanged in `evidence/realtime.sql`, SHA-256
`7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88`.
It reads `POSTGRES_USER` through a psql shell metacommand, creates `_realtime` if
absent, and explicitly sets the schema owner even if the schema already exists.
This matches the generated fixed `POSTGRES_USER=supabase_admin` and Realtime
search path. It defines no tables, grants or publication membership.

`Dockerfile.db` now copies this exact input to
`/docker-entrypoint-initdb.d/migrations/99-realtime.sql`, the native location
identified by the pinned upstream Compose file. A future build first rejects an
existing destination and then verifies the copied file with `sha256sum -c -`.
It neither templates nor executes SQL. The upstream native `migrate.sh` processes
that migration-directory file through psql; the existing
`zz-harness-passwords.sh` remains a later top-level initialization hook.
No second SQL runner is added and no startup adapter is changed. Native execution
order is retained by placement; actual bootstrap success remains untested.

The explicit context allowlist adds only `evidence/realtime.sql`: its parent is
traversable, `evidence/**` remains excluded, and that one file is re-included.
Registry metadata, other evidence, docs, fixtures and caller configuration remain
excluded. The original SQL's `.gitattributes` and raw bytes are unchanged.
No image has been built, so the provenance field `runtime_installed` stays false;
`build_integration_defined` records the new definition without claiming execution.
The bundled platform may create unused platform schemas/roles; preserving its
native dependency chain does not add Storage, Studio or other excluded services.

### Auth and PostgREST

Native binaries, native Auth migrations and native role identities remain intact.
Only internal `db` and `mail` addresses are generated. Public-facing Auth URLs use
the Task #1 reserved namespace origin, never host-published ports. Mail confirmation
is enabled; phone, anonymous-user and external provider configuration is excluded.
PostgREST exposes `public`, uses `authenticator` and `anon`, and disables legacy GUCs.

The definition selects the upstream-supported **HS256 configuration** shared by
Auth, PostgREST and Realtime. Local signing material and signed anon/service JWTs
remain unresolved. This is a deliberate simplification from the review's possible
asymmetric-key arrangement: publishable keys are opaque gateway keys, not a JWT
algorithm. The gateway maps them to distinct internal signed tokens, preserving
user JWTs. No signing, usable key generation or credential persistence is added in
this task. Algorithm/issuer/expiry and foreign-token rejection remain runtime tests.

### Realtime

The native release migrations, seed implementation and server are retained. The
[seed](https://github.com/supabase/realtime/blob/d46540b3a4a79113f40301d5e5cb690f41150b9b/priv/repo/seeds.exs)
deletes a matching tenant before recreation, so `realtime.sh` claims a persistent
`seed-attempted` marker with noclobber before the first database action. Any second
attempt fails, including recovery after a lost/uncertain first attempt.

Release temporary files, HOME and crash dumps are redirected to the approved
volume. pgdelta's bundled compressed executable is expanded during image building;
no executable is downloaded or run by that step. Cloud crash-upload and certificate
bootstrap code and `set -x` are excluded from the adapter. Release node discovery is
replaced with a single-container local Erlang node. Outbound metric pushers remain
disabled, and all database/tenant settings are explicit internal values.

The pinned runtime configuration constructs `realtime.supabase.co` as its endpoint
URL. The derived image matches that exact line once and substitutes the internal
`http://realtime:4000` endpoint. It fails a future build if the expected line/layout
changes. Tenant routing still uses a unique nonce-derived tenant and the gateway's
matching `Host` rewrite, not a static upstream container name. Native SQL is not
patched; application publication membership remains a later, separate step.

### Gateway

`gateway.lua` is a small harness adaptation of the official Supabase
[key filters](https://github.com/supabase/supabase/blob/e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7/docker/volumes/api/envoy/lds.template.yaml),
not a byte-identical copy. It preserves opaque publishable/secret-key translation,
legacy internal key acceptance, user-JWT preservation, WebSocket query-key
translation and `x-api-key` propagation. It does not verify JWT signatures itself.
Invalid user tokens must reach backend verification or be rejected; they must not
silently become anonymous requests.

Only Auth, REST and the Realtime WebSocket route exist. Auth health and GET email
verification are public; other application routes require a known key. Excluded
service and tenant-administration routes return 404. Conflicting header/query or
opaque bearer keys, duplicate/empty query keys, encoded query parameter names,
and malformed Authorization headers fail closed; these ambiguity checks are
intentional stricter harness behavior, not historical application schema changes.
CORS is limited to the reserved origin. There is no Envoy admin listener or
request access log. The gateway listens on port 54321 inside the private network.

The upstream `/etc/envoy` template writes and dashboard password hashing are
replaced by validated substitutions into the allowed runtime volume. Generated
keys have a restricted alphabet; JWT substitution rejects multiline values and
shell/JSON/Lua metacharacters. No arbitrary template/configuration input exists.
Hot restart is disabled, avoiding shared-memory paths/capabilities.

Offline tests execute this exact Lua source against in-memory header/route stubs
using an already-installed liblua 5.3/5.4. This does not validate Envoy protobuf
configuration, Envoy's LuaJIT embedding, HTTP behavior or WebSocket handshakes.

### Mail sink

Mailpit uses explicit non-root ownership, an explicit SQLite file and temporary
paths under its own runtime volume, and only internal ports 1025/8025. Reverse
DNS, version checks and remote UI CSS/fonts are disabled. No SMTP relay/forward,
webhook or SpamAssassin integration is supplied. These settings require later
behavioral confirmation and egress-denial probes.

## Task #3B image/input binding

Integration checkpoint: `9d6355073a3515567037a462fb6c33d3a1191826`.
All six Dockerfiles have literal `repository:tag@sha256:<amd64-child-manifest>`
FROM references. There are no `ARG` instructions or digest overrides. The generated
Compose document keeps `platform: linux/amd64` and an empty build-argument map.
The full-document validator rejects added arguments, alternate architectures,
index/config/ARM64 digests, foreign references and changes to runtime guards.

`verify_build_inputs` runs before a plan is emitted or accepted. It checks the
immutable Task #3A registry evidence-file hash, source-file hash, selected platform
metadata, actual child-manifest body hash, Dockerfile FROM lines, bootstrap copy
location/hash check and exact build-context rules. Missing/malformed or altered
inputs fail with a fixed error. It performs local reads only. The plan's artifact
hash inventory now includes the two nested evidence files, so source drift cannot
hide behind the previous top-level-only inventory. A future executor still needs
to build from a validated immutable context snapshot, preventing check/use races.

The trusted reviewed repository remains the policy boundary; editing both policy
code and evidence is not an authorized configuration mechanism. The original
Task #3A hashes remain historical evidence in `task3a.runtime_files_unchanged`.
Task #3B separately records the intentionally integrated definitions and the files
that must remain unchanged, rather than rewriting that historical record.

## Build and runtime gates

All Compose entrypoints still point to the intentionally absent
`/harness/TASK_2_RUNTIME_DISABLED`. Healthchecks remain disabled, derived images
have `pull_policy: never`, credentials remain invalid placeholders, and
`require_runtime_ready` always rejects. No runtime-enable input, build/start/export
CLI or lifecycle executor was added. The fixed input digests replace the earlier
invalid build arguments as requested; that is not runtime authorization. Blocker
messages now describe the remaining build/execution gates instead of incorrectly
claiming that source identities are unresolved.

**GO for committing Task #3B. Conditional GO for a separately authorized controlled
build-only task; NO-GO for runtime or database initialization.** Before any build,
that next task must:

1. Inspect the pinned base-image config metadata (including ONBUILD, inherited
   environment, declared volumes, entrypoints and effective defaults); source and
   manifest identity alone do not establish safe build behavior.
2. Verify the selected local builder/daemon and architecture, snapshot the exact
   allowlisted context and recheck its hashes, reject inherited overrides/remote
   contexts, and retain network-disabled RUN steps. Base-image acquisition needs
   explicit authorization and must use only the verified immutable references.
3. Define unique build output ownership, a journal of any builder/cache resources,
   failure behavior and exact cleanup scope. Do not reuse unrelated resources or
   introduce global prune. Builds execute RUN steps and may create intermediate
   builder containers; this requires build-only authorization, not runtime access.
4. Keep every service entrypoint blocked. Do not start services, initialize a
   database, execute SQL, install Grocery fixtures, or apply Migration 003/004.
   Stop and report any incompatibility without relaxing the existing guards.

No such inspection/build was performed here. Volume copy-up ownership, users and
writable paths, PostgreSQL/native bootstrap compatibility, credentials, readiness,
actual network isolation, protected lifecycle journaling and teardown remain
runtime prerequisites. Browser namespace placement must preserve the fixed origin
without host ports or forbidden shared-network overrides. All previously recorded
limits on signatures, source-to-image correspondence and ARM64 behavior remain.
