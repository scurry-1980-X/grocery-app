# Harness Task #3A — upstream provenance closure

Research checkpoint: `fe8f6392813b0430e0ec5b2caed23a2989a771a8` on
`codex/isolated-restore-verification`. Observations: 2026-10-21 UTC.
**Provenance-only changes; runtime remains disabled.**

## Exact Realtime source

- Repository: official `supabase/supabase`.
- Commit: `e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7`.
- Path: `docker/volumes/db/realtime.sql`.
- [Raw source](https://raw.githubusercontent.com/supabase/supabase/e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7/docker/volumes/db/realtime.sql).
- [Commit-addressed GitHub view](https://github.com/supabase/supabase/blob/e854b84ed4517b0f21a1acd0a0abdd8a8d5cb9a7/docker/volumes/db/realtime.sql).
- Preserved artifact: [`evidence/realtime.sql`](evidence/realtime.sql), **117 bytes**.
- SHA-256: `7e9e442e7fc4dae05544c07b67bede37a00d84644304dfce4d937134cb4c8f88`.
- Locally derived Git blob SHA-1: `4d4b9ffb912b9312dd78257956c180f12913264d`.
  This is a computed blob identity, not a separately obtained Git tree proof.

The raw HTTPS response was retained byte-for-byte: no scaffolding removal,
escaping, substitutions or line-ending normalization. The file contains LF line
endings and a final LF. `.gitattributes` disables Git text conversion for it.
The separate GitHub page reported the same full commit and identical source lines.
The pinned Compose source was re-fetched; its SHA-256 still matches the previously
recorded `1bf8df5776dd81e9be15790851b46cdca1d0be8556450d4c88d73089d3b97a8b`.
It maps this file to `/docker-entrypoint-initdb.d/migrations/99-realtime.sql:Z`.
The harness must eventually bake the exact file into the image instead of adopting
that upstream host bind mount.

The source contains a psql `\set` using shell command substitution to read
`POSTGRES_USER`, `CREATE SCHEMA IF NOT EXISTS _realtime`, and a separate
`ALTER SCHEMA _realtime OWNER TO :pguser`. Consequently:

- The fixed generated `POSTGRES_USER=supabase_admin` matches the intended owner.
- An existing schema's owner is explicitly set too. Merely using `CREATE SCHEMA
  IF NOT EXISTS ... AUTHORIZATION ...` would not reproduce that behavior.
- It creates no application objects, functions, grants, policies or publication
  membership. Native Realtime migrations/seed still perform later initialization.
- It is a psql input script; sending its text through a generic SQL API would fail.
- Its environment-derived, unquoted identifier is safe only under the harness's
  fixed identity contract. Do not make `POSTGRES_USER` user-configurable.

There is no source-level conflict with Task #1 guards. There **is** a missing
installation step in Task #2: the source is not currently copied into native
bootstrap. No runtime file or build-context rule is changed in this task.

## Registry verification method and limits

All six public Docker Hub repositories were queried through the normal HTTPS
proxy using GET requests to `registry-1.docker.io/v2/<repository>/manifests/...`.
The registry requires its anonymous token challenge protocol. Tokens were obtained
without any account login, username/password, API key, Docker configuration,
GitHub credential or hosted-project credential; they stayed in memory and are not
part of the evidence. No Docker daemon/client or container tooling was used.

For each image, the index was fetched by the requested tag, hashed locally, and
compared with `Docker-Content-Digest`. It was then fetched again by that immutable
digest and required to match byte-for-byte. Each Linux amd64 and arm64 child
manifest was fetched by its index descriptor digest; its body hash, response digest,
size and media type were matched against the descriptor. **6 indexes and 12 child
manifests passed.** No layer blobs, image configs, signatures or attestation blobs
were fetched. This is registry metadata research, not an image pull/build/run.

[`evidence/registry-manifests.json`](evidence/registry-manifests.json) preserves the
18 raw response bodies as JSON strings, without reserializing the embedded bodies.
UTF-8 encoding those strings recovers the exact bytes used for their digests.
The record includes source URLs, observation times, digest headers, sizes and
media types. `provenance.json` records the evidence-file hash and the selected
`linux/amd64` identities. Offline tests reconstruct and validate that chain.

Publisher platform labels establish the registry's advertised architectures;
the binary contents were not inspected. Every image advertises Linux amd64 and
arm64, with no variant field on those descriptors. Mailpit additionally advertises
Linux 386; that child was not fetched. `unknown/unknown` attestation descriptors
are not runnable architectures. PostgREST's amd64 child uses Docker schema-2
manifest/config media types, while its arm64 child uses OCI types; both are
content-addressed and verified. All six top-level documents are OCI indexes.

The current tags' association with these digests was observed on the recorded
date. Tags can move. The indexes and child manifest digests are distinct from
config digests, layer digests and Git source hashes. Registry identity verification
does **not** establish source-to-binary correspondence or verify signatures/build
attestations. Earlier source commit records remain source-review evidence only.

## Verified identities

All values below include the `sha256:` algorithm prefix. The harness currently
targets `linux/amd64`; arm64 manifest verification is not ARM64 runtime approval.

### `supabase/postgres:17.6.1.136`

| Identity | SHA-256 digest |
| --- | --- |
| OCI index | `sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00` |
| linux/amd64 manifest | `sha256:5a4314708484bec672de2c09653a5c01fb1c84a998564ac231b0325e2238ed5b` |
| linux/arm64 manifest | `sha256:a9946f08d31e8eb1149229c94e5c26603a9233116807cbbd93d75179cbac516a` |

### `supabase/gotrue:v2.197.0`

| Identity | SHA-256 digest |
| --- | --- |
| OCI index | `sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b` |
| linux/amd64 manifest | `sha256:839f529492d116b4e8b7777c953a27c381d34c15a744b1bcefde5eefaa1f9f9f` |
| linux/arm64 manifest | `sha256:3439d5affb9e96395d1348521f4c675eea7096d8d76d18d4e31fcc08df802116` |

### `postgrest/postgrest:v14.18`

| Identity | SHA-256 digest |
| --- | --- |
| OCI index | `sha256:c7cd7e265a85b05248abf53f4473fcec7e327c282d0bd0cf60f1551996d09fcf` |
| linux/amd64 manifest | `sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0` |
| linux/arm64 manifest | `sha256:dfa6464b877fa7b1b0be85740f6ce6985144b509a6edb5f09c5ee67e687e8c1f` |

### `supabase/realtime:v2.143.3`

| Identity | SHA-256 digest |
| --- | --- |
| OCI index | `sha256:768b559241dd234c4e8852c5c0f504e598b80f1df2ad4dd78d5486fbed2f17a2` |
| linux/amd64 manifest | `sha256:1591e9049bf15fd392da9e8344db892f6acfe9da274517327dbd14733f32b9e1` |
| linux/arm64 manifest | `sha256:39abd3593110424c8512ffdaefd6b3ef016a5867065a87c1658e9bc55199a464` |

### `envoyproxy/envoy:v1.39.4`

| Identity | SHA-256 digest |
| --- | --- |
| OCI index | `sha256:74bd4eb5629708d3fadca1a5e6b85d208f338d7bb54e06b69565905c5294cc01` |
| linux/amd64 manifest | `sha256:63dd445d23d7d419d1bba8b2b9b1b8fdb80f38ae1516fb5d2dcd8856713b7eac` |
| linux/arm64 manifest | `sha256:ce82b213b2c9190aa9fa2fc76678743a690681cbd668de32dd749e3e4da52862` |

### `axllent/mailpit:v1.31.6`

| Identity | SHA-256 digest |
| --- | --- |
| OCI index | `sha256:23fe39e81bde596a918000b3135c0f85dc8bb4c9ea6be274b051143f3e300387` |
| linux/amd64 manifest | `sha256:059454962fbda891cfa621c86a251cfd9cfe645cb43e0dcd9351a35e7a8f3155` |
| linux/arm64 manifest | `sha256:cc34e6c1995288cd30a4d2bf7fe5cded246c6f2b7fa8199bbc911205721f76dc` |

## Required later changes and readiness

A separately reviewed configuration task must:

1. Wire the selected platform digests (or verified index plus explicit platform)
   into generated build definitions and their full-document validation. Do not
   silently resolve mutable tags or accept caller-supplied digests.
2. Bake the exact recovered Realtime source at the native `migrations/99-realtime.sql`
   location, with an explicit build-context allowlist change and source hash check.
   Preserve the fixed PostgreSQL identity, native initialization order and failure
   handling. Do not add this platform source to Grocery baseline fixtures.
3. Inspect published image configs/effective defaults and filesystem expectations,
   then implement the separately reviewed build/runtime gate, protected local key
   generation, readiness, daemon binding, ownership journal, network/egress probes
   and exact-inventory teardown. Maintain the current restrictions throughout.

**GO for committing Task #3A provenance work. NO-GO for the first combined
controlled build/runtime phase as currently defined.** The requested source and
manifest-identity gaps are closed, but evidence has not been integrated into the
disabled stack and operational safety prerequisites remain outstanding. A future
build-only phase may be scoped separately after its configuration and execution
controls are reviewed; this task does not create or authorize such a phase.

No Dockerfiles, shell adapters, gateway runtime configuration, stack generator,
Task #1 guards, baseline fixtures, legacy permissions or Migration 003/004 were
changed. No recovered SQL was executed. No images, services or databases were
started, and no hosted Supabase project was contacted.
