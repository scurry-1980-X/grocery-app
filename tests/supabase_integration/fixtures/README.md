# Historical application baseline fixtures

These fixtures reconstruct the reviewed **backup-time pre-Migration-003 application
baseline**, based on branch `codex/isolated-restore-verification` at
`e92e307f0db65dbd6d74b3eb2f74e96f2ea0f5a5`. They are not original migration files,
a production installer, or evidence of current production state. Construction
and offline checking are authorized; database execution is not. Migration 003
remains **NO-GO for production**.

## Sources and object coverage

Paths below are relative to the repository root. `provenance.json` pins source
and fixture bytes with SHA-256 and identifies the evidence used per object group.

| Objects / properties | Evidence and confidence |
| --- | --- |
| Three legacy function definitions, signatures, PostgreSQL ownership, SECURITY DEFINER and empty search paths | Exact recovered source: `sources/grocery-three-functions.sql`, preserved byte-for-byte from the reviewed attachment; only CRLF-to-LF normalization in 001 |
| `grocery_items`, `grocery_list_members`, `grocery_list_invites`: columns, types, nullability, defaults, PKs, FKs and deletion actions | Strongly derived from the expected catalog in `scripts/restore_validation/catalog_checks.sql`; not recovered original CREATE TABLE text |
| `grocery_items_id_seq`: identity BY DEFAULT, sequence name/dependency, increment 1, minimum 1, no cycle | Catalog checks; identity DDL constructs the dependency. Owner-only ACL is derived from the postgres/public sequence default ACL and absence of a sequence ACL entry in `scripts/validate_grocery_restore.py`'s strict archive allowlist |
| Four tables' RLS enabled and not forced; exactly five permissive authenticated policies | Catalog checks, corroborated by `scripts/restore_validation/behavior_checks.sql`; no invitation or creation-ledger policy, no membership write policy |
| Table and function ACLs, postgres/public per-schema defaults | Exact expected ACL sets in catalog checks, corroborated by restore results; explicit fixture statements reconstruct the sets, not the original grant/revoke history |
| `grocery_list_create_requests`, its PK/FK, RLS, owner; `create_grocery_list_once` | Exact DDL/function from `database/recovered/002_deployed_objects.reconstructed.sql`; ACLs expanded to explicitly reach the catalog-evidenced end state |
| Absence of application triggers, extra indexes/constraints, list table and other public application objects | Strict archive allowlist and catalog inventory; primary keys create their required indexes |
| Historical successful verification | `docs/RESTORE_VERIFICATION_RESULTS.md`: two 29-check restores, including archive-to-restored function-body comparisons; these were historical runs, not runs of these fixtures |

The supplied extraction attestation identifies archive FUNCTION entries 484, 485
and 486, rendered using `pg_restore 17.11` without connecting to a database. The
user verified the archive hash on their iMac. We independently verified the
attachment hash, and its archive identity matches the committed recovery
manifest. We did **not** independently re-open the full archive or verify those
entry numbers. The dump header's pg_dump 18.6 identifies the archive producer,
not the extraction tool. Hashes establish byte integrity, not an independent
signature of the user's provenance claim.

## Intentional transformations

- Preserve the raw attachment (including mixed line endings and dump scaffolding)
  under `sources/` for review only. Its `.gitattributes` disables text conversion
  and exempts the historical CRLF/footer blank line from whitespace warnings;
  this source is **never an installation input**.
- Extract the three complete CREATE FUNCTION and ALTER FUNCTION OWNER statements.
  Normalize CRLF to LF in the runnable fixture, preserving bodies, comments,
  spelling, arguments and attributes. The 002 function and ledger DDL are copied
  from the committed recovered record without semantic changes.
- Remove dump headers/footers, random psql restrict/unrestrict guards, session
  timeouts, client encoding/messages, xmloption, row_security=off, search-path
  set_config and check_function_bodies=false. Do not disable function checking.
- Install tables and constraints before functions. In particular, 002 creates
  the ledger before create-once; the archive rendering put the function first.
  Install 001 then 002, each in its own transaction. Fresh CREATE statements
  intentionally fail if application objects already exist; no replacement,
  deletion, data restoration or idempotent installation is provided.
- Use transaction-local postgres role, empty search path, function checking,
  default tablespace and heap access method. These are installation controls,
  not newly recovered application objects. The last two preserve 002 dump
  storage settings without leaking session settings.
- Explicitly remove inherited grants for PUBLIC, anon, authenticated and
  service_role on each new application object, then grant the evidenced sets,
  including owner entries. Expand function GRANT ALL to EXECUTE. No grant options.
  This preserves historical legacy access rather than imposing new restrictions.
- Reconstruct the evidenced postgres/public **per-schema** default ACL records
  at the end of 001, then explicitly normalize 002's object ACLs. Per-schema
  revocation does not cancel global default grants. Global defaults and defaults
  owned by managed roles are platform inputs, not altered here.
- Render policy expressions with `public.` qualification and explicit PERMISSIVE;
  these preserve the catalog expressions and default policy mode.

## Historical behavior deliberately retained

There is no `grocery_lists` table or list-ID FK. Nullable item fields, quantity
without a positivity check, owner references without ON DELETE CASCADE, broad
legacy table grants, and membership-only item policies remain unchanged. No
owner-equals-caller constraint or name validation is introduced. All four tables
have enabled, unforced RLS. No policies are added to invite/creation ledgers.

Legacy create-list is not idempotent. Invite creation checks authentication and
membership without locking the membership row. Invitation expiry defaults to
`now() + interval '7 days'`. Redemption consumes an unused, unexpired invitation
with a row-locking UPDATE and wall-clock comparison, then inserts membership
with ON CONFLICT DO NOTHING. An existing member can consume a valid invitation;
a repeat redemption fails even for its original redeemer. Redemption does not
recheck the inviter's membership. These are historical behaviors, not fixes.
The create-once implementation preserves caller-scoped request replay and its
revoked-membership guard exactly.

## Future disposable installation prerequisites and limits

A separately reviewed harness must first verify isolation, an empty application
namespace, PostgreSQL 17+ (MAINTAIN privileges), native Supabase `auth.users` and
`auth.uid()`, existing postgres/anon/authenticated/service_role roles, and the
ability to install as postgres. These files create or replace none of those
platform objects and contain no connection settings. **The SQL alone cannot
identify a production connection**; do not run it manually against an arbitrary
database. Harness isolation and installation are a later authorization gate.

Use only 001 followed by 002 as application baseline inputs. Realtime publication
membership/options, replica identity, managed event triggers, public-schema
USAGE/CREATE, managed owner defaults and Auth role attributes belong to separate
platform setup/verification, not these fixtures. In particular, do not reuse
the historical validator's ID-only Auth stubs or its non-BYPASSRLS service role.

Unknown global/default grantees, inherited role memberships, column privileges,
or managed event-trigger effects could change effective access. The fixtures
normalize the evidenced named roles; a future harness must reject unexpected
ACLs/objects and compare resulting application catalogs before running tests.
Do not apply the old full catalog checker unchanged to native Supabase: its
"no managed schemas", stub-role, total-default-ACL-count and historical-data
checks deliberately target a different isolated restore environment.

Sequence start/cache/max and physical index/storage options are not fully
established by the catalog evidence; PostgreSQL defaults are used where no
historical setting is established. No private sequence position or rows are
restored. Column order follows the evidence listing, not independently recovered
attnums. Source/current production schema identity, native Auth/API/Realtime
behavior, actual SQL compilation and runtime catalog equivalence remain
unverified. No Migration 003 objects, revision machinery or Migration 004
restrictions are included. Existing synthetic SQL-test fixtures stay separate.

## Offline validation

From the repository root (no database, Docker, network or SQL execution):

```sh
PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s tests -p 'test_*.py' -v
```

The new tests pin source/output hashes, compare exact normalized function
statements and recovered 002 DDL, and check the supported fixture SQL subset
against catalog columns/defaults/constraints, RLS/policy scope and ACL sets.
Negative mutations exercise rejection of source drift, unexpected SQL and grant
changes. They are static checks, not a PostgreSQL parser or runtime proof.
