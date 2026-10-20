# Migration 003 additive `add_items` — proposal and isolated tests only

Prepared October 19, 2026 from branch `codex/isolated-restore-verification`,
commit `072cb66f386f1111768ad4ed01db109b27eef149`. This extends the existing
`003_replay_safe_mutations.name_validation_v2.sql` proposal; its filename is
retained for existing review/test references. It still requires a **fresh 003
installation** over the 002 baseline, not an upgrade or rerunnable migration.
Production deployment is not authorized by this work.

## Contract and decisions

New callers may eventually submit:

```json
{
  "request_id": "a fresh UUID persisted before the first send",
  "target_list_id": "the selected list UUID",
  "operation": "add_items",
  "payload": {
    "items": [
      {"id": -123, "item_name": "Milk", "quantity": 2, "purchased": false}
    ]
  }
}
```

- Exactly one top-level payload key, `items`; exactly four keys per item as
  shown. Unknown/missing keys and wrong JSON types fail. In particular,
  `owner_id`, per-item `list_id`, `created_at`, and `revision` are rejected.
- Between **1 and 200 items**, matching recovered `insertBatchLocked()` and
  `receipt()`. Names may repeat; IDs must be unique within the batch.
- IDs are JSON numbers representing negative integers in
  `[-9007199254740991, -1]`, matching the client's safe-integer receipt contract
  and avoiding the positive identity sequence. Quantities are JSON integral
  numbers from 1 to 999. Purchased is a required boolean, preserving imported
  purchased state. Numeric strings and fractions fail; integral numbers such
  as `1.0` are accepted without rounding. Returned IDs are decimal strings.
- Names use the existing canonical rule: JSON string, nonblank under the exact
  ECMAScript trim set, and at most 150 UTF-16 units in the original value. No
  trimming, case folding, or Unicode normalization is applied to storage or
  the ledger payload. PostgreSQL rejects NUL/unpaired surrogates at JSON decode.
  The add and edit predicates are kept local to their branches to preserve the
  inherited edit behavior; both run the same 83-case corpus in PostgreSQL.
- `auth.uid()` supplies the owner. Membership in `target_list_id` is checked
  and locked `FOR SHARE` before the request reservation, including on replay.
  Revocation blocks behind an active mutation; a mutation waiting behind a
  committed revocation is denied. A revoked caller cannot replay old results.
- The existing private ledger is keyed by `(user_id, request_id)`. Its unique
  constraint serializes duplicate requests. List, operation and JSONB payload
  must match; changed contents or array order fail. JSON object key order and
  equivalent numeric spellings are equal under JSONB, as for existing operations.
- The entire batch is validated before one INSERT statement. IDs are inserted
  in ascending order to reduce deadlock risk for overlapping batches. Existing
  IDs fail with a uniqueness error, including legacy rows or rows on other lists;
  there is no upsert, skip, receipt promotion, or content-based reconciliation.
- The item changes, ledger reservation and final result write share the RPC
  transaction. Any error rolls back all effects. A first transaction that aborts
  leaves no reservation; a waiting retry can then create the items once.
- The result is `{ "status": "ok", "items": [...] }` in submitted order. Each
  entry snapshots `id` (string), `item_name`, `quantity`, `purchased`, `list_id`,
  `owner_id`, `created_at`, and the actual trigger-assigned `revision`. The
  ledger stores the snapshot, so a retry returns it even after edit, deletion,
  or reuse of an item ID. It is a creation receipt, not current list state.

No recovered browser code or receipt behavior changes. In particular, uncertain
`grocery-save-v1` INSERT receipts **must not** be converted to `add_items`
requests or retried automatically: the old insert may already have committed.
Direct INSERT/UPDATE/DELETE permissions and legacy APIs remain in place.
Migration 004 and every file under `database/recovered/` are unchanged.

## Isolated verification

The portable harness accepts no database URL, backup or existing container.
It uses the local Docker Unix socket explicitly, creates a uniquely named
container with networking disabled, no ports, no host mounts and no PostgreSQL
TCP listener, then verifies those settings before loading synthetic fixtures.
Every database connection uses the container's Unix socket. It applies only the
proposal, uses claim-aware test `auth.uid()`, exercises authenticated roles,
and removes only its own temporary container/data when finished, including on
test failures. It neither loads production data nor executes reconstructed 002.

Prerequisites: Python 3.9+, Node 20+, Docker's local socket, and a locally pulled
`postgres:17` image. From the repository root:

```sh
python3 tests/migration003_isolated.py --run-isolated
node --test --test-reporter=tap tests/*.test.cjs reviews/shared-client-recovery-2026-10-19/verify-offline.cjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

The explicit `--run-isolated` flag prevents accidentally launching SQL tests
through ordinary unit-test discovery. These commands never target production.
The new fixture is a deliberately limited 002-shaped synthetic schema; its
invitation helper fails closed. The existing edit-name SQL generator runs in
the same isolated container without changing its case expectations.

Coverage includes single/batch creation and result order, canonical name cases,
strict payload validation, 0/1/200/201 batch boundaries, ID/quantity boundaries,
duplicate IDs, existing/global collisions, full rollback on validation/INSERT/
ledger-result failures, identical and changed replays, caller-scoped requests,
anonymous/NULL/nonmember access, private-ledger denial, direct-write compatibility,
and creation replay after edits/deletion/ID reuse. Lost-response behavior is
simulated by committing through a separate connection, discarding its response,
then retrying against the ledger. This is not an HTTP fault-injection test.

Six concurrent cases observe a real PostgreSQL lock wait before releasing the
first transaction: identical retry, changed retry, retry after abort, different
requests colliding on an ID, and membership revocation in both orderings.
The existing edit/delete/frozen-clear operations also receive runtime coverage.

### Execution results — October 19, 2026

| Suite | Result |
| --- | --- |
| Isolated PostgreSQL integration | **21/21 test groups passed**, 79.015 seconds |
| Canonical names within PostgreSQL integration | **83 add + 83 edit cases passed**, each 41 accepted / 42 rejected |
| Observed concurrent lock cases within integration | **6/6 passed** |
| All Node suites, including browser and recovered-client/offline recovery | **133/133 passed**, no skips |
| Existing restore-validator safety regressions | **13/13 passed** |
| Diff whitespace/error check | Passed |

Runtime: PostgreSQL **17.11**, UTF8, READ COMMITTED; Node **24.19.0**.
PostgreSQL image digest:
`sha256:2d2b8998d31037bf721cfdf764d76ba74171b4fab3431b7f72c27c56ddbdf9e3`.
The final integration run removed its owned test container successfully.
The initial browser run could not operate under the default sandbox; the full
133-test rerun with local network permission passed. No application change was
needed for that environment limitation.

Exact tested source SHA-256 values:

| File | SHA-256 |
| --- | --- |
| `003_replay_safe_mutations.name_validation_v2.sql` | `b160bfc82f3f0b85fde08e7c174f088636395079bf10f5343ab71b85552cd8d4` |
| `tests/migration003_isolated.py` | `9596d488fc4780355ace1c561ed23e2a4360a50b71e7aba63b9afcce265f3402` |
| `tests/fixtures/migration003_baseline.sql` | `414dca24a1dd52d38be3b3a164cafcc21fa0fe5ccf0f160f08cee4090f958293` |
| `tests/migration003_name_validation.test.cjs` | `2f453d70c90d74c42c65b6b360936b32e1591520e5a4f8f4817d31c48b04ed6b` |

### Resumed review and reverification — October 20, 2026

Inspected and preserved the existing uncommitted implementation at `072cb66`;
the four source hashes above still match. No implementation changes were needed.
Reran all suites: **21/21 PostgreSQL groups passed** in 139.077 seconds,
**133/133 Node tests passed** with no skips, and **13/13 restore-validator safety
tests passed**. The PostgreSQL run again covered both 83-case name corpora and
all six observed lock-contention cases, and successfully removed its test
container. The private-backup integration was not rerun. All six changed files
remain uncommitted; no push, merge, deployment, or production SQL was performed.

## Remaining concerns

This is the first additive compatibility component, not a cutover. Legacy
writes still bypass the new validation/ledger; existing data is not repaired.
Client adoption, durable new-operation receipts, uncertain legacy-receipt review,
and Migration 004 require separate work. Permanent account policy, ledger
retention/storage growth and backup/rollback reconciliation remain unresolved.

Synthetic PostgreSQL tests do not establish Supabase JWT/Auth, PostgREST/schema
cache, managed grants/dependencies, Realtime, actual transport-loss behavior,
invitation semantics, or iPhone behavior. Concurrency checks cover selected
READ COMMITTED interleavings, not all isolation levels, schedules, or load.
The complete original 002 schema is not reconstructed here. The existing
private-backup restore integration is unchanged and is not rerun with private
data; its 13 safety regressions are run. Production preflight, deployment and
recovery approval remain separate decisions.
