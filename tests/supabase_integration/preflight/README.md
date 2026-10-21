# Task #4A — build preflight, stopped before build authorization

Checkpoint: `c5f1d886e3094c7c3963dbf2c16520d4a4460a80` on
`codex/isolated-restore-verification`. Observed 2026-10-21 UTC.

**GO to commit this evidence and offline validation. NO-GO for build-only Task
#4B in the inspected environment until the daemon-binding and cache-ownership
gaps below are resolved. Runtime remains disabled.** No image was built, no layer
was pulled, and no container, database, fixture or migration was started/executed.
No permissions, daemon configuration or existing safety contracts were changed.

## Local daemon and builder observations

[`observations.json`](observations.json) records selected non-secret observations,
not reusable authorization. Read-only queries were `docker context inspect
default`, explicit `--host unix:///var/run/docker.sock` version/info, and
`buildx inspect default` **without `--bootstrap`**. No resource creation, cleanup
or image inspection through a daemon pull was attempted.

- Default context: exactly `unix:///var/run/docker.sock`, no TLS bypass; it passes
  the existing Task #1 context projection. The path is a socket, not a symlink.
- Docker Engine 28.4.0/API 1.51 reports Linux amd64; host reports x86_64. Storage
  driver is `vfs`, Swarm inactive. Daemon ID is
  `969f6627-7b4d-4212-b159-027363ed7d6c` for this observation only.
- Default builder: Docker driver, BuildKit v0.24.0, reported running, with
  `linux/amd64` and v2/v3/v4 variants. No builder was bootstrapped or created.
  The selected plain amd64 manifests match its advertised architecture; no
  emulation is proposed. Binary contents have not been inspected.
- Local PID 183 is `dockerd`, UID 65534, with a command line explicitly selecting
  the required Unix listener. Socket owner UID is also 65534, and the socket is
  visible in `/proc/net/unix`. These are consistent with a local daemon, but
  `/proc/183/fd`, its network namespace link and the daemon pidfile are unreadable.
  **Independent socket-to-process/namespace binding is not proven.** No permissions
  were changed or alternate remote daemon selected to overcome this restriction.
- The first Buildx inspection failed while creating client metadata in the
  read-only home directory. A retry used an empty temporary `BUILDX_CONFIG` and
  removed inherited Docker/Buildx/BuildKit/Compose/Container selectors from that
  inspection process only. It succeeded and selected the default Docker driver.
  This does not relax the harness's rejection of ambient selectors.
- The builder reports daemon-wide cache GC policies, including `All: true`.
  No per-run cache namespace, exclusive daemon lease or ownership journal is
  established. Those existing policies were only read, never invoked or changed.

**Stop condition:** the current default builder cannot be approved as an isolated
harness-owned cache. A separately reviewed environment/builder arrangement must
establish local identity and exclusive cache/GC boundaries without privileged
builder containers, remote contexts or weaker Task #1 controls. `--no-cache` would
not establish isolation: it neither disables new cache writes nor daemon GC.
No further daemon work was performed after recording these gaps; the remaining
work was offline evidence preservation, context validation and documentation.

## Exact pinned image configurations

[`image-configs.json`](image-configs.json) preserves six raw config response bodies
as UTF-8 JSON strings, their immutable URLs, sizes and SHA-256 identities. Each
descriptor comes from the previously committed **amd64 child manifest**, whose
raw bytes are independently hashed against the Task #3B pin. Config body bytes
are hashed and size-checked against that descriptor. No mutable tags are resolved
by this task. Prior Task #3A records remain unchanged historical observations.

Acquisition used only official Docker Hub auth/registry endpoints and the
registry's official `production.cloudfront.docker.com` metadata redirect. This
Docker CDN is unrelated to production Supabase. The initial redirect was blocked
until its host was inspected; the subsequent handler allowed only that HTTPS host
from the registry and dropped the registry Authorization header. Anonymous public
repository tokens and signed CDN query strings were held in memory and not stored.
Proxy and TLS verification remained enabled. No account/project credentials,
layer blobs, signatures or attestations were requested. Offline tests make no
network requests.

All six config bodies declare **linux/amd64**, have no `OnBuild` triggers and no
`Volumes`. There is no inherited custom `Shell`. Missing/empty user means the base
image's default root behavior, not proof of the eventual derived runtime user.

| Service / exact base tag | Base ENTRYPOINT | Base CMD | Base USER | Base WORKDIR |
| --- | --- | --- | --- | --- |
| `supabase/postgres:17.6.1.136` | `docker-entrypoint.sh` | `postgres -D /etc/postgresql` | default/root | `/` |
| `supabase/gotrue:v2.197.0` | absent | `auth` | `supabase` | `/` |
| `postgrest/postgrest:v14.18` | absent | `/bin/postgrest` | `1000` | absent |
| `supabase/realtime:v2.143.3` | `/usr/bin/tini -s -g -- /app/run.sh` | `/app/bin/server` | `nobody` | `/app` |
| `envoyproxy/envoy:v1.39.4` | `/docker-entrypoint.sh` | `envoy -c /etc/envoy/envoy.yaml` | default/root | absent |
| `axllent/mailpit:v1.31.6` | `/mailpit` | absent | default/root | `/` |

Config identities (distinct from the FROM manifest digests):

| Service | Config SHA-256 |
| --- | --- |
| db | `f519727303f0af6862882be2a30f420e28710d4209226e681aaddb2c01d12d9b` |
| auth | `1181bff5ba4ce440013a63cef9f4cf13024c432d705c9b1fbc9e5b949e852f48` |
| rest | `455fe971661e8c8c2722aece9f1e40e15871fb350724ca5433d54e40f5ade3c8` |
| realtime | `e01aa9d85dc543a64c427e15002c544bbe03467d14741de7b69787aaf2e40177` |
| gateway | `d4800f30429fc946d03932a6055a2d52c70183aa60487f9da38899f1543dfe6a` |
| mail | `978742ab0aca1fb510b407aa54d3cc9fb1d51ca4988ce0bc6fbdb1fdc6afbc4c` |

Environment review (the evidence retains every exact value):

- PostgreSQL supplies its Nix/PostgreSQL PATH, PGDATA, Unix POSTGRES_HOST,
  `POSTGRES_USER=supabase_admin`, `POSTGRES_DB=postgres`, ICU initdb arguments,
  locale variables, Groonga plugin directory and locale archive. No password is
  present. Existing runtime definitions override data/socket paths; native
  bootstrap remains a later, explicitly prohibited phase here.
- Auth supplies standard PATH and `/usr/local/etc/auth/migrations`; its explicit
  derived entrypoint replaces the base CMD. Actual binary/path availability is
  not established by config metadata.
- PostgREST has an empty Env list; its derived image contains no shell RUN steps.
- Realtime supplies standard PATH, empty SLOT_NAME_SUFFIX, locale, MIX_ENV=prod,
  ECTO_IPV6=true and ERL_AFLAGS using inet6_tcp. Existing runtime configuration
  explicitly selects IPv4 database connectivity and inet_tcp distribution; this
  task changes neither. Combined native behavior remains untested.
- Envoy supplies standard PATH and DEBIAN_FRONTEND=noninteractive; Mailpit supplies
  standard PATH. Neither includes external endpoints or credentials.

PostgreSQL and Mailpit inherit healthchecks, explicitly disabled by all reviewed
derived definitions and Compose. ExposedPorts metadata exists on PostgreSQL,
PostgREST, Envoy and Mailpit; it does not publish host ports. No `-P`, port mapping,
base entrypoint execution or healthcheck execution was performed. All derived
definitions already set final numeric users, explicit entrypoints and empty CMDs;
Compose still overrides them with the missing runtime blocker entrypoint.

No metadata-level incompatibility was found with the reviewed definitions.
Config identity proves the advertised metadata, not source-to-binary provenance,
filesystem layout, trusted executable contents or successful builds.

## Exact build context snapshot

[`context-snapshot.json`](context-snapshot.json) records every admitted filename,
byte size, mode and SHA-256, plus the deterministic archive identity:

`275f942a17514ee388187349d6b39e247662a83f65f703338c5e0bb594943f0d`

The shared context contains **15 files**: `.dockerignore`, six Dockerfiles,
seven adapter/gateway files, and the exact `evidence/realtime.sql`. All source
bytes were compared with the checkpoint. The archive is **40,960 bytes**, USTAR,
with a directory entry for `evidence`, sorted file entries, UID/GID/mtime zero,
empty owner names, file modes 0644 and directory mode 0755. Git records the files
as 100644; the workspace materializes them as 0600. Only archive metadata is
normalized; no filesystem permissions or source bytes were changed.

A snapshot was created locally at `/tmp/grocery-4a-review/context.tar` for this
review. It was never handed to Docker and is not a persistent repository artifact.
The committed inventory plus the offline generator reproduces its exact bytes;
a future executor must freshly validate and consume those bytes, not rebuild a
context by walking mutable source paths after validation.

The verifier uses a fixed file list, accepts only ordinary single-link files with
0600/0644 source modes, rejects symlinked roots/parents/files, special files,
unexpected Dockerfiles and Dockerfile-specific ignore overrides. Exact allowlist
comparison rejects new context inclusions. COPY accepts only explicit reviewed
file paths and absolute non-traversing destinations: no globs, variables, JSON
forms, `--from`, remote/absolute sources, directories or parent traversal. ADD,
parser overrides and RUN option overrides are rejected. The exact snapshot hash
also binds every RUN instruction and adapter byte to the reviewed checkpoint.
These checks are intentionally narrower than general Dockerfile syntax.

The snapshot contains no config evidence, registry evidence, documentation,
application fixtures, repository metadata, keys or caller configuration. Realtime
SQL bytes and its native copy destination remain unchanged. Source reads are not
a sandbox against a concurrent actor who can edit the trusted repository or
validation code; an eventual executor needs exclusive input capture and must use
the verified immutable archive to prevent check/use races.

## Future output ownership and cleanup boundary

This is a design only; no images, cache namespaces or journal were created.

1. Generate one fresh Task #1 `RunIdentity` nonce, persist it in a protected
   journal, and never accept a caller-supplied nonce. Before building, bind the
   journal to the freshly verified daemon, builder, platform, context archive,
   each base manifest/config and exact permitted actions. Recorded observations
   in this directory are not live authority.
2. Preserve existing derived tags `grocery-harness-<nonce>-<service>:task2` so the
   disabled stack remains compatible. `output_identity` defines required image
   labels: owner, run, kind=image, component, context-sha256 and base-manifest,
   using `com.grocery.integration.*`. The suffix `task2` is the existing local tag
   convention, not permission to resolve mutable upstream tags. Tags/labels must
   be injected and verified by a later executor; this task does not wire one in.
3. Require destination tags and output paths to be absent before build. Record
   full resulting image/config IDs and all created references. If filesystem
   outputs are selected, use a freshly created private run directory named
   `grocery-it-<nonce>-build` and fixed component filenames; reject existing paths,
   links or paths outside that journaled directory. No shared output overwrite.
4. Image cleanup requires separately authorized exact journal/observation matches,
   including daemon identity, full image ID, exact tag and labels, immediate
   reinspection, and no foreign tags, dependent images or containers. Fail closed
   on any discrepancy; no prefix-based deletion, forced image removal, wildcard
   removal or use of runtime container cleanup helpers for images. Base images
   and unrelated image references are outside harness cleanup authority.
5. BuildKit cache is not owned merely because an output image has labels. The
   current Docker driver shares cache and GC; **no cache cleanup is safe to define
   for it by nonce/prefix**. A later reviewed arrangement must provide an exclusive,
   attestable cache boundary and record its complete lifecycle before first use.
   No `docker system prune`, builder/buildx prune, broad cache deletion or GC
   policy changes are allowed. Do not add a privileged BuildKit service to solve
   this gap. Failure/interruption must preserve the journal and leave ambiguous
   artifacts untouched for review.

## Offline validation and remaining gates

Run from repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_supabase_build_preflight.py' -v
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_*.py' -v
```

The new tests bind six configs to existing manifest evidence, reject altered
bodies/identities/acquisition flags, reproduce and inspect the context archive,
reject path/context widening and link attacks, validate output naming, and verify
that offline validation uses no network/process APIs and grants no build/runtime
authority. Existing suites continue checking Task #1 guards, Task #2 blockers,
fixture/source provenance and recovered-client behavior.

Task #4A results: **14/14 new preflight tests passed; 112/112 full Python offline
tests passed**, zero failures. The full Python suite includes fixture/restore,
safety, stack, gateway and upstream-provenance regressions. Browser/Node suites
were not rerun: no client code changed, and this task's regression execution was
kept offline. Exact seven-file scope, unstaged index, unchanged checkpoint and
branch, protected-source byte equality and whitespace checks passed.

The helper is not a CLI, Docker client or executor. `require_build_ready` always
rejects. Stack, Dockerfiles, adapters, fixtures, permissions and Task #1 remain
unchanged. The original `require_runtime_ready` always rejects too.

Before reconsidering Task #4B: establish independent local daemon binding,
exclusive cache/GC ownership, and a reviewed build-only executor/journal that
consumes the exact snapshot with network-disabled RUN steps, fixed architecture,
no credential/SSH/secret forwarding and no implicit runtime actions. Base layer
acquisition requires that later authorization. The existing collision/path checks
may intentionally fail a future build; stop rather than patching them ad hoc.
Runtime initialization, native bootstrap, volume ownership, egress/isolation,
credentials and teardown remain separate gates even after successful builds.
