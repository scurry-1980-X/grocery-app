# Migration 003 name-validation revision — review only

Prepared and updated October 19, 2026. **Isolated PostgreSQL regression: PASS.
Production deployment remains NO-GO.**

The proposal now also includes the additive `add_items` component described in
[003_ADD_ITEMS_REVIEW.md](003_ADD_ITEMS_REVIEW.md). The verification record and
SHA-256 values below describe the earlier name-validation-only revision, not
the current extended proposal/test generator. Both add and edit now use the
canonical name rule; direct/legacy writes still bypass it.

`003_replay_safe_mutations.name_validation_v2.sql` is a new proposal derived from
`../recovered/003_replay_safe_mutations.recovered.sql`. It is not recovered
historical SQL. All four files under `database/recovered/` remain unchanged.
The historical SQL's SHA-256 remains
`a527c250905838d166b203b608a914f39345a5c93c1e9744868dc08b09aea531`.

This revision targets a fresh Migration 003 installation after the deployed
Migration 002 baseline. It is intentionally not a rerunnable migration or a
patch for an already installed 003. Existing-object collisions should fail;
silently skipping them could preserve an unknown implementation. Do not run the
reconstructed 002 as a prerequisite migration. The proposal was applied only in
the previously authorized isolated test described below. This documentation
update does not execute SQL or authorize deployment.

## Defect and root cause

The recovery report documents the mismatch at historical 003 lines 90–94.
The RPC validates `length(btrim(payload->>'item_name')) BETWEEN 1 AND 150`,
then stores the original, untrimmed string. The recorded shared client rejects
non-strings, strings empty after JavaScript `.trim()`, and raw `.length > 150`.

These expressions encode different contracts:

| Example | Historical RPC name check | Recorded shared client | Revised RPC rule |
| --- | --- | --- | --- |
| `Milk`, `牛乳`, 150 ASCII characters | Accept | Accept | Accept |
| Empty string or ordinary spaces only | Reject | Reject | Reject |
| Tabs, NBSP, BOM, or mixed trim whitespace only | Accept | Reject | Reject |
| `a` followed by 150 spaces (151 raw units) | Accept | Reject | Reject |
| 75 supplementary characters (150 UTF-16 units) | Accept | Accept | Accept |
| 76 supplementary characters (152 UTF-16 units) | Accept | Reject | Reject |
| Short valid name with surrounding whitespace | Accept and preserve | Accept | Accept and preserve |
| JSON null, missing field, number, boolean, array, object | Reject | Reject | Reject |

PostgreSQL's default `btrim` removes ordinary spaces, and `length(text)` counts
characters. Under UTF8, `ascii(text)` returns the first Unicode code point.
See [PostgreSQL 17 string functions](https://www.postgresql.org/docs/17/functions-string.html).
JavaScript trim uses the ECMAScript WhiteSpace and LineTerminator sets, and
strings count UTF-16 code units. See the [trim definition](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.trim)
and [String type](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-string-type).

The underlying error is using an approximate SQL validation rule without a
shared definition of whitespace, length units, and whether length applies
before or after trimming. A successful edit can consequently leave a row that
the recorded client's list loader refuses to load.

## Proposed correction and scope

The proposal explicitly requires a JSON string, rejects names empty after
trimming the 25 ECMAScript whitespace/line-terminator characters, and enforces
at most 150 UTF-16 units in the **raw submitted value**. It rejects more than
150 PostgreSQL characters before a bounded scan; each supplementary code point
counts as two UTF-16 units. A UTF8 server-encoding preflight makes that counting
assumption explicit.

Trimming is an emptiness test only. The stored name and ledger payload remain
unchanged, preserving the historical raw-storage behavior and exact-payload
replay comparisons. There is no case folding, Unicode normalization, grapheme
counting, or new character allowlist. Internal newlines and zero-width space
remain accepted when the recorded client accepts them. A different product rule
requires a coordinated client/server change.

In the earlier name-validation-only revision, changes were limited to the
encoding guard, local variables, and edit-name validation. The current extension
also adds `add_items`; source comparison tests still guard the inherited
revision trigger, ledger, membership locking, edit quantity/purchased checks,
replay behavior, invitation/delete/clear logic, RLS and grants.

## Client differences still visible

- The shared-client name predicate is a **historical contract fixture**, sourced
  from the recorded `shared.js` read in cloud turn
  `01a14edd-695a-72bb-bf7d-dabd9d1cc60e`, command
  `exec-62204db3-d398-4453-b8b4-e2d61a9fd9e8`. A reconstructed shared client and
  sanitized runner are now available in
  [`reviews/shared-client-recovery-2026-10-19/`](../../reviews/shared-client-recovery-2026-10-19/README.md).
  Their original final release identity remains unverified. The name tests still
  use the recorded contract fixture; they do not establish what is deployed or
  exercise the reconstructed client's complete loader/receipt flow.
- The current `index.html` is local-only. Its parser trims input and rejects an
  empty list; the form has `maxlength="150"`, but the parser itself accepts
  overlength strings when called directly. Tests execute the actual page script
  to document this distinction. The proposal does not change that client.
- JavaScript can represent NUL and unpaired UTF-16 surrogates, and the historical
  name predicate accepts them. PostgreSQL text/jsonb cannot store those values;
  request decoding must reject them before the RPC can validate them. Offline
  tests expose this difference, and the isolated PostgreSQL run confirmed JSON
  decoding rejection. Supabase HTTP errors and client handling remain untested.
  See [PostgreSQL JSON input restrictions](https://www.postgresql.org/docs/17/datatype-json.html).
- The canonical check now applies to both the `edit` and `add_items` operations.
  Migration 003 remains additive: legacy/direct inserts and updates can bypass
  it, and existing rows are not validated or repaired. All active write paths
  and existing data need the same contract before a shared-client release.
  A table constraint or shared validation helper would be a separately reviewed
  change with an existing-data and rollout plan; none is silently added here.

## Regression tests and results

From the repository root, with Node.js 20 or later:

```sh
node --test tests/migration003_name_validation.test.cjs tests/parser.test.cjs
```

Result on Node 24.13.1: **96 tests passed, 0 failed**. These include 83 name cases,
the three documented mismatch mechanisms, exact trim-set checks, historical
hash/scope checks, actual local-parser differences, and a database-suite
generation check. The name cases compare a JavaScript contract fixture with an
offline semantic model of the proposed SQL. They do **not** execute or parse
PL/pgSQL and cannot establish database correctness by themselves.

The following command emits the prepared SQL test suite to stdout without
opening a database or executing any SQL. Any new database run requires separate
authorization and isolation checks:

```sh
node tests/migration003_name_validation.test.cjs --emit-sql
```

The emitted suite does not install a migration. It expects the revised 003 to
have already been applied with approval to a disposable PostgreSQL 17 UTF8
database with the 002 baseline and a claim-aware `auth.uid()`. The existing
restore test's NULL-returning auth stub is insufficient and fails preflight.
The suite requires the explicit psql flag `isolated_migration003_test=true`, a
database name beginning `grocery_m003_`, and setup as `postgres`. These are
mistake-prevention checks, not proof of isolation: independently verify the
target is a new network-disabled test container with no production credentials.

It uses generated fixture UUIDs and an explicit negative item ID, runs the 83
cases through the actual RPC as `authenticated`, verifies raw storage, revision
changes, exact replay, and rejected-edit rollback (including ledger entries),
then rolls back fixtures. An ID collision aborts instead of overwriting data.
It does not modify sequences or replace auth functions. Errors stop psql; use
a dedicated disposable connection so a failed transaction is never committed.
The generated suite was executed during the previously authorized isolated run
below. Concurrency was covered by additional local scripts, not by this generator.
Neither suite covers Supabase HTTP decoding, real Auth, or Realtime.

## Completed isolated PostgreSQL verification

On October 19, 2026, the unchanged proposal and prepared suite ran successfully
on **PostgreSQL 17.11, UTF8, READ COMMITTED**, in a fresh Docker container with
networking disabled, no published ports, no PostgreSQL TCP listener and no host
mounts. All sessions used the container's local Unix socket. Only generated test
identities and synthetic grocery data were used; no backup or production data
was loaded. Existing containers and recovered historical files were unchanged.

Exact tested inputs for that earlier run (superseded by the additive revision):

- Proposal SHA-256:
  `4a3631cc71dbe5515891179d4c7a77a959791946880813376f97f113a840d331`.
- Prepared test generator SHA-256:
  `637a8629579d068d8383b6933b96e057e13861921e68d76dfbe10f5a17636f98`.

**83/83 name cases passed: 41 accepted and 42 rejected.** Accepted names were
stored unchanged, received fresh revisions, and replayed without another effect.
Rejected names left both the item and request ledger unchanged. Coverage includes
empty/whitespace-only names, all 25 trim characters, non-string JSON, Unicode,
raw length boundaries and supplementary characters. The prepared suite rolled
back all its fixtures and verified zero remaining users/items/ledger rows from
that suite; this does not claim the additional tests left the container empty.

**12/12 additional behavioral checks passed**, including seven deliberately
contended concurrent cases. The observer verified a database lock wait before
releasing the first session in each concurrent case:

| Concurrent case | Verified outcome |
| --- | --- |
| Identical request and payload | One effect and identical replay result |
| Different requests with the same original revision | One winner; stale edit conflicts |
| Identical request after first transaction aborts | Waiting request applies once |
| Same request ID with changed payload | Rejected; first committed result preserved |
| Clear Purchased against unpurchase/edit | State/revision rechecked; replay cannot expand frozen targets |
| Membership revocation against mutation | Revocation waits; later replay is denied |
| Delete against stale edit | No row resurrection; stale edit conflicts |

The other checks verified whole-transaction rollback after invalid input,
PostgreSQL rejection of NUL/unpaired surrogates, private-ledger and authorization
denials, replay of the copied 002 create-once function after 003, and frozen-clear
deduplication/replay. All **18 recorded check groups** passed, including setup,
source integrity and isolation checks; these groups overlap the cases above and
are not 18 additional independent tests.

This summary was checked against the retained local report, results and source
hashes. Raw evidence, generated SQL/logs, container state and machine-specific
setup/concurrency scripts remain ignored under `.restore-validation/` and are
not part of this commit candidate. The portable prepared generator is included;
the additional concurrency harness needs separate portability review before
preservation in Git. No database tests were rerun for this documentation update.

Limitations: the prerequisite schema was synthetic. Only the recovered 002
create-once function body was copied as a fixture; the recovered migration file
was not executed. `auth.uid()` read a test claim and `auth.users` held synthetic
IDs, so this was not JWT/session or complete Supabase permission testing. The
invitation helper deliberately failed closed: invitation creation/redemption
and the invite RPC branch remain untested. Concurrency coverage was limited to
seven interleavings at READ COMMITTED, not exhaustive scheduling/load tests,
other isolation levels, or deadlock/network recovery. These results establish no
current production schema, data, grants or deployment readiness.

## Remaining deployment blockers and next actions

1. Accept the validation contract and review/adopt the reconstructed client as
   an integration baseline. Align every insert/edit path and existing row with
   it; direct/legacy writes still bypass RPC validation and replay protections.
   Review NUL/surrogate rejection UX and any stricter character policy. Browser
   input limits do not enforce database rules.
2. Preserve a portable version of the additional isolated concurrency harness
   after separate review. Validate real prerequisite schema/grant compatibility
   and invitation behavior in an approved disposable environment. The completed
   synthetic PostgreSQL tests do not establish full Supabase compatibility.
3. Run the exact client against disposable Supabase for Auth/JWT authorization,
   API/schema-cache and error handling, Realtime revisions, lost-response retry,
   durable receipts, and two-device/iPhone behavior. Decide whether permanent,
   confirmed accounts are required beyond a non-NULL `auth.uid()`.
4. Define ledger retention/storage limits, pending-receipt reconciliation,
   staged rollout and a separately approved 004 cutover. The inherited 003 does
   not remove legacy write permissions or make those writes replay-safe.
5. Rehearse recovery using a copy of the validated pre-003 backup. It establishes
   a Grocery App restore baseline, not full Supabase Auth/API restoration or
   preservation of writes after the backup. Agree how post-backup writes and
   browser receipts are reconciled before a rollback can be considered safe.
6. Before any deployment, separately authorize a current-state preflight for
   dependencies, object collisions, ownership/grants, data, and revision-column
   backfill/locking impact, then conduct another readiness review.

The prior authorized isolated test applied only the corrected proposal to its
synthetic test database. That earlier documentation update performed no SQL execution,
container operation, production access, commit, push, merge or deployment.
Recovered historical files remain unchanged. **Deployment is still NO-GO** until
the integration, write-path, rollout and recovery blockers above are resolved
and deployment is separately approved.
