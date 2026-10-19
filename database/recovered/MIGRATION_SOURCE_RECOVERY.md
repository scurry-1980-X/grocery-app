# Migration source recovery — review artifacts only

Investigation: October 18–19, 2026 (America/Chicago). Final integrity review
completed October 19. Repository base for this work:
`5a728703f12381054623f12655d045f34b679b74` on
`codex/isolated-restore-verification`.

**Migration 002's backup-time deployed objects have been reconstructed and
cross-checked. A complete historical Migration 003 proposal has been recovered.
Neither artifact is represented as a verified original migration file. Neither
should be executed from this directory. Migration 003 remains NO-GO.**

## Files and confidence

| File | What it establishes | What it does not establish |
| --- | --- | --- |
| `002_deployed_objects.reconstructed.sql` | Schema-only rendering of seven selected archive entries, including the exact archived function body, ownership and ACLs | Original migration bytes, original statement order, every operation originally performed, or present production state |
| `003_replay_safe_mutations.recovered.sql` | Exact decoded text of the complete 153-line proposal from a historical file-read tool result | Original on-disk bytes/line endings, a Git revision, absence of later edits, deployment, or readiness approval |
| `provenance.json` | Sources, classification, file hashes and verification results | An independent signature or an original-file hash recovered from its author |

The files deliberately live in `database/recovered/`, not `database/migrations/`
or the original `database/proposals/` paths. They are records for review, not
pending migrations. The existing validator and application were not changed.

## Why the files were missing

The user reported searching local Git histories and SQL files under the home
directory, excluding Library. This investigation additionally checked the local
repository's reachable history for `database/`; it contained no such history.
The preceding readiness review found no proposal at the specified path in the
accessible local checkouts or the remote development/shared branches checked.

The earlier cloud chat, **Set up grocery-app**, contains both file creation and
later file-read records in `/workspace/grocery-app`. Its Git status output shows
work on `ai-managed-development` with `?? database/`, and its completion messages
state that the work remained uncommitted. This explains how the files could
exist in the cloud workspace without appearing in the Mac checkout or remote
branch. It is evidence of uncommitted work, not proof of deletion or a lost Git
commit. No branch reset, fetch, checkout, push, or merge was performed here.

## Migration 002: reconstructed deployed-object record

Primary source: `grocery-pre-migration-003-full.dump`, the existing backup that
passed the isolated restore verification. Its local SHA-256 was compared with
the existing container copy before rendering, and the source checksum was
unchanged afterward. The archive reports PostgreSQL 17.11 and pg_dump 18.6.

The only Docker operations were reading the restore-tool version, archive
checksum, archive table of contents, and rendering selected schema entries with
`pg_restore --schema-only --use-list=/dev/stdin --file=-`. No database connection
argument was supplied, no psql command ran, and no emitted SQL was executed.
Existing containers were neither started/stopped nor removed during recovery.

Seven archive entries were selected:

1. `public.create_grocery_list_once(uuid)` function.
2. Its function ACL.
3. `public.grocery_list_create_requests` table.
4. Its table ACL.
5. Its `(user_id, request_id)` primary key.
6. Its `user_id -> auth.users(id) ON DELETE CASCADE` foreign key.
7. Its RLS-enable entry.

The reconstruction preserves rendered schema statements and settings, adding a
provenance warning and removing pg_restore's random `\restrict` and
`\unrestrict` guards. Trailing empty footer lines were also removed during
pre-commit formatting review; no schema statements or function bodies changed.
It includes no table data or auth identities. It preserves
the archive rendering order; it is not an execution-ready original migration.

The record establishes:

- Four NOT NULL columns: `user_id uuid`, `request_id uuid`, `list_id uuid` with
  UUID default, and `created_at timestamptz` with current-time default.
- PostgreSQL ownership, the primary/foreign keys, RLS enabled, and no ledger
  policies in the historical verification/validated baseline.
- A SECURITY DEFINER UUID-returning function with an empty search path,
  authentication/request checks, caller-scoped uniqueness, atomic membership
  creation, a subsequent read for replay, and revoked-membership protection.
- PUBLIC execution revoked; authenticated execution granted. Historical
  effective-permission verification also denies anon execution and all client
  ledger table/column privileges.
- The archived table ACL grants `REFERENCES, TRIGGER, TRUNCATE, MAINTAIN` to
  `service_role`. These privileges are retained as evidence. They are consistent
  with the archived PostgreSQL public default privileges; they must not be
  silently removed to make the record resemble the original proposal.
- The validated backup's ledger count was zero. No data was reread during this
  reconstruction, and zero rows are not a requirement for all future operation.

Cross-checks performed without executing SQL:

- The full archived function body exactly equals the body assembled from the
  user's two earlier deployment-verification messages. The first message was
  truncated; the second supplied the final membership guard and function end.
  Its missing comment was supplied from the explicit continuation marker.
- Against the earlier recorded Migration 002 proposal, the function text matches
  after removing comments and whitespace. This is a textual comparison, not a
  formal SQL equivalence proof or a claim of original-file identity.
- Table shape, constraints, security mode and effective client permissions agree
  with that earlier user-supplied verification and the saved restore evidence.

The archive describes resulting objects, not the original deployment procedure.
For example, absence of a client grant in a dump is not a safe substitute for
explicit revocation when deploying into an environment with different defaults.
Do not use this reconstruction to redeploy 002 or overwrite its ledger.

## Migration 003: historical proposal recovered

Source: the later read command in cloud turn
`01a14edd-695a-72bb-bf7d-dabd9d1cc60e`, whose exact command-item identity is
recorded in `provenance.json`. The command read
002, 003 and 004 consecutively. Its combined output was truncated at 12,000
characters, **inside Migration 004**. Migration 003 begins with its proposal
comment and ends with its own `COMMIT;` before 004 starts. All 153 lines are
present; the recovered segment contains no redaction markers.

The earlier creation command also contains 003, but that command representation
has shell quoting and a redaction marker. It was not used as the recovered file.
The later rendered file-read output is the source of the saved SQL. The saved
file was compared exactly with the extracted decoded text. Its new SHA-256 is
an integrity check for this recovery, not a historical original-file checksum.

The recovered design includes:

- A UUID revision column and BEFORE INSERT OR UPDATE trigger assigning a fresh
  revision on each write.
- A private `(user_id, request_id)` mutation ledger holding list, operation,
  payload, result and creation time.
- `mutate_grocery_once(uuid, uuid, text, jsonb)` for invitation creation, edits,
  deletion, and Clear Purchased, with membership locking and payload matching.
- Revision comparisons and a frozen target set for Clear Purchased.
- Atomic effect/result recording and caller-scoped replay.
- Additive staging: legacy writes and RPC access remain until separate cutover.

Because this complete historical proposal was recovered, no replacement 003 was
invented. Its known defects were deliberately not edited into the recovered
record. Any correction must be a separately identified, reviewed revision.

## Uncertainties and missing decisions

1. **Authoritative version:** no original file/hash or immutable commit for 002
   or 003 is available. Confirm whether the recovered 003 snapshot is the final
   intended proposal; later cloud-only edits cannot be excluded.
2. **Name-validation defect:** 003 lines 90–94 use PostgreSQL
   `length(btrim(item_name))`, while the recorded updated client checks JavaScript
   `.trim()` and raw UTF-16 `.length`. Tab-only names, overlength values padded
   with spaces, and 76 supplementary characters can pass the RPC but fail the
   client's list loader. Agree on normalization and length semantics, apply them
   consistently to all write paths, and add boundary tests in a future revision.
3. **Auth policy:** decide whether membership alone is sufficient or permanent,
   confirmed email accounts are required. A non-NULL `auth.uid()` does not by
   itself enforce the latter. Client restrictions are not server authorization.
4. **Replay lifecycle:** define ledger retention, maximum payload/storage growth,
   error retry behavior, and reconciliation of durable browser receipts after
   recovery. Deleting replay records while old requests can return can repeat
   effects. An old backup does not contain requests committed after capture.
5. **Client/runner provenance:** recorded updated source uses 002/003 RPCs and
   revisions, but the accessible committed development client is local-only.
   Identify the actual deployment and Mac runner bundle; decide the staged
   rollout and the later, separately approved 004 cutover. Do not claim that
   003 alone prevents legacy callers from bypassing replay protection.
6. **Current database assumptions:** backup-time and historical verification
   evidence do not establish current production grants, ownership, isolation,
   triggers, collision status or data. Any future preflight needs separate
   authorization; none was run here.
7. **Recovery and platform tests:** isolated Grocery restore passed; actual Auth
   identity/session recovery, Supabase API/schema-cache behavior, Realtime,
   concurrent HTTP replay, and two-device/iPhone behavior remain separate gates.
   The retained auth stubs are not a restorable Supabase identity service.

## Recommended next steps

1. Review these recovery artifacts and their provenance, then explicitly accept
   a version as the design baseline. Preserve the distinction between archived
   deployed state, historical proposal and future corrected implementation.
2. Record 002 as already deployed; do not run it again. Recover the complete
   cloud client/runner sources before attempting an integrated release.
3. Prepare a separately named revision of 003 addressing the validation defect
   and the policy decisions above. Keep this historical snapshot unchanged.
4. With separate authorization, test that revision and the exact client through
   isolated PostgreSQL and a disposable Supabase environment. Prior test reports
   are historical evidence, not a fresh test of a newly reconstructed package.
5. Rehearse recovery without overwriting production. Include how post-backup
   writes and pending browser receipts are handled, and preserve Migration 002.
6. Only then perform another readiness review. No migration, production action,
   commit, push, merge, or cleanup is authorized by this report.

Validation in this investigation was limited to archive rendering, metadata
inspection, textual comparisons, integrity hashes, and source/privacy review.
No SQL, migrations, application RPCs or production requests were executed.
