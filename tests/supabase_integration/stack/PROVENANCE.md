# Task #2 stack definitions: provenance and deliberate adaptations

**Configuration only; no image has been pulled, built or run.** The checkpoint is
`fdc03783253d0fe2d34255ae061568002fc2d694`. Baseline fixtures and Task #1 guards are
unchanged. `provenance.json` records their SHA-256 hashes, the image candidates,
full upstream source commits, exact source URLs and 32 cached-source hashes.
Those hashes were rechecked locally during this task. No network research was
performed during implementation. The earlier authorized review compared seven
core source files at their version tags and full commits; all seven matched.

The upstream source cache was read from `/tmp/grocery-upstream-source-review`.
It is not a repository dependency and is not vendored here. Source hashes identify
review evidence; they are not OCI manifest, platform or image digests. All six OCI
digests are explicitly `null` / `UNRESOLVED`. Do not replace them with invented
hashes or assume a tag is immutable. The document targets `linux/amd64`; native
ARM64 support, image manifests and any emulation require separate review.

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
Resolving base images in a later build still requires separate authorization.

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

**New evidence limitation:** the cached official Compose file mounts
`volumes/db/realtime.sql`, but that file's body was not captured by the earlier
review. The native Realtime configuration explicitly uses `_realtime` as its
search path, but that does not establish the missing file's complete contents.
**No replacement schema statement or bootstrap implementation is supplied.**
The exact missing source is
[`docker/volumes/db/realtime.sql` at the pinned Supabase commit](https://github.com/supabase/supabase/blob/e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7/docker/volumes/db/realtime.sql).
Its contents and hash are unresolved; this link identifies required evidence,
not a source fetched or reviewed in this task. Obtain and review it in a separately
authorized source-review step, then verify native bootstrap parity before runtime
approval. The present stack is deliberately incomplete at this prerequisite.
It is separate from the historically recovered Grocery fixtures.
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

## Runtime approval remains a separate gate

All Compose entrypoints point to the intentionally absent
`/harness/TASK_2_RUNTIME_DISABLED`, and base-image healthchecks are disabled.
Digest build arguments are invalid `UNRESOLVED` values, local derived images have
`pull_policy: never`, and credential slots are non-secret invalid placeholders.
`require_runtime_ready` always rejects. There is no runtime-enable input. These
are accidental-use barriers, not permission to invoke Compose: a manually invoked
Compose command could still create resources before failing. No such command is
provided or executed.

A future reviewed task must supply image/platform digest verification, native
bootstrap parity, protected local key generation/persistence, dependency readiness,
image effective-config inspection, daemon binding, fresh-volume ownership and
network/egress checks, lifecycle journaling and exact-inventory teardown. It must
also resolve the browser namespace placement without weakening the fixed origin
or adding host ports/shared-network overrides. Image adaptation/build/start is
not authorized by these documents. No baseline fixture, Migration 002/003 or
Realtime application publication installation is wired into startup.
