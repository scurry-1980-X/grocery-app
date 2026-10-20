# Shared Grocery App client recovery — review candidate only

## Additive `add_items` client transition — October 20, 2026

This review implementation starts from `4a22d15` on
`codex/isolated-restore-verification`. New single-item, multi-item and local-import
adds use `mutate_grocery_once(..., 'add_items', ...)`. The recovered client and
runner contain no direct INSERT call or INSERT fallback. The original local-only
application and both empty shared configuration files remain unchanged.
Deployment remains **disabled / NO-GO**. SQL, legacy permissions, RLS and
Migration 004 are not changed.

The protocol is extended in place: `grocery-mutation-v1:<user>` and Web Lock
`grocery-write:<user>` are unchanged, and both protocol copies are identical.
An older protocol reader rejects an unknown `add_items` receipt rather than
overwriting it. Reload old tabs before adopting this candidate; this is not a
way to upgrade already-running legacy code.

### New adds and imports

One lock encloses preparation, dispatch and local finalization. The client
validates the complete 1–200 item batch, canonical name/quantity/boolean values
and unique negative safe integer IDs. It generates IDs and the request UUID
once, writes and verifies the complete receipt, then dispatches the persisted
copy. No ID or payload is regenerated for a retry. Server validation and
ownership remain authoritative; client payloads contain no owner or list fields.

The receipt adds client-only `intent: {kind: 'add'}` or
`intent: {kind: 'import', source: <original local JSON string>}`. This metadata
never enters the RPC payload. Import names, quantities and purchased values must
match that source. The original local list is retained. After validating the
server's complete ordered creation snapshot, finalization writes and verifies
`grocery-imported-v1:<original user>:<original list>` **before** confirming the
RPC receipt. A lost marker can be repaired from the latest confirmed import
before another operation overwrites that single receipt slot.

Dispatch uses the captured session token after `getUser(token)` verifies its
caller. The separate RPC client uses that token in memory, with SDK write
retries disabled. Account/list epoch guards run before and after the send.
Changing accounts cannot turn the original caller's pending operation into a
different caller's write; changing lists cannot retarget its payload. Recovery
always uses the saved list, even if another list is currently selected.

The creation snapshot is validated against saved IDs, caller/list and values,
including revision and timestamp fields. It is **not** compared to today's rows:
edited/deleted items still have a valid ledger creation receipt. A refresh
failure after confirmation disables writes and reports a saved operation;
it does not reopen the request or leave a successful add looking unsaved.

### Legacy compatibility and independent recovery

`grocery-save-v1:<user>:<list>` is never converted, resubmitted or erased.
The client discovers pending legacy receipts across that caller's lists, even
when the original list is unselected or no longer accessible. New mutations are
blocked while any legacy uncertainty or malformed receipt remains. A distinct
legacy selector/check action and RPC resume action allow either existing path
to recover independently. A malformed receipt cannot hide an independently
recoverable receipt; it still blocks new writes.

Legacy checks issue **SELECT only**, scoped to the original list and frozen IDs,
without depending on 003 revision columns. Confirmation requires exactly one
row for every expected ID with exact list, owner, name, quantity and purchased
values. Response order does not matter. Absent, partial, extra, duplicate,
changed, malformed, inaccessible or unreadable results retain the receipt and
require another read or manual data review. Presence is evidence of current
matching rows, not proof of historical execution; absence is never proof of
failure. A legacy import also writes its original source marker before local
confirmation. There is no automated recreation or “repair” INSERT.

### Failure and recovery states

| Event/state | Durable evidence and next action |
| --- | --- |
| Validation, ID generation or initial storage fails | No network write; preserve form/local source. Repair the cause before a fresh attempt. |
| Pending receipt persisted; tab reloads before/during/after send | Same request ID, item IDs, original list and payload remain. Explicit resume only. |
| Commit succeeds but response is lost/unreadable | Pending; replay the original request, receive the stored snapshot, never create a replacement. |
| Membership/access/auth/capability denial, collision, request mismatch or unknown error | Pending; recover access or request review. These errors do not establish that a prior creation failed. |
| Exact supported post-ledger `add_items` validation rejection | Persist `confirmed` with `result.status: 'rejected'`, retain original ID and form; allow a later explicit correction with a fresh ID. |
| Import marker persistence fails | Keep pending even after server success; retry the original RPC and finalize the original marker. |
| Receipt confirmation persistence fails | Recover from the persisted evidence. Never automatically issue a fresh add. |
| Successful confirmation, later edit/delete or refresh failure | Creation remains confirmed. Refresh current rows separately; never resurrect them. |
| Legacy SELECT does not exactly match, or storage/identity changes | Legacy pending retained; no RPC or INSERT promotion. |

For `add_items`, only structured HTTP 4xx responses (excluding 408/429) with
SQLSTATE `P0001` and one of the five exact post-ledger validation messages are
terminal: `Add requires an items array`, `Add batch must contain 1 to 200 items`,
`Invalid add item`, `Invalid item values`, `Duplicate add item ID`.
The broader existing `072cb66` rejection rules continue for the other operations.
Access checks precede ledger lookup in 003, so treating an add recovery's access
denial as a fresh failure would lose uncertain creation history.

### Automated verification and scope

```sh
node --test --test-reporter=tap tests/*.test.cjs reviews/shared-client-recovery-2026-10-19/verify-offline.cjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 tests/migration003_isolated.py --run-isolated
```

The new `tests/shared_add_items.test.cjs` executes the actual client, protocol and
runner functions with storage/transport faults, not an independently rewritten
client. It covers the 83 canonical names, batch/ID/quantity boundaries, exact
replay and snapshot validation, rejection classification, import finalization
failures, account/list changes, legacy reconciliation, mixed/corrupt receipts,
old-reader compatibility and runner stop behavior. Five cases run the bundled
SDK against fake fetch responses and inspect its RPC body and bound caller token.

`tests/shared_add_items.browser.test.cjs` serves the actual recovered HTML,
parser, shared client and protocol to Chromium with loopback-only transport.
It covers single/multi/import form events, reload while a response is in flight,
commit followed by an unreadable response and access denial, real Web Locks
between two tabs, storage events, mixed receipts, storage failure and failed
post-confirmation refresh. Browser Auth/SDK transport is a fixture; no Supabase
service or production configuration is used. PostgreSQL tests separately use
only a new network-disabled container and synthetic data.

Final results (Node 24.19.0, Python 3.12.14, Chromium 154.0.8037.57,
PostgreSQL 17.11):

| Suite/check | Result |
| --- | --- |
| All Node suites, including original parser/browser/recovery tests | **301/301 passed**, 0 failures/skips, 66.118 seconds |
| New add transition cases within Node total | **168 passed**: 162 protocol/client/runner/fault cases and 6 real-browser cases |
| Restore-validator safety regressions | **13/13 passed** |
| Isolated PostgreSQL integration | **21/21 groups passed**, 74.706 seconds; owned container removed |
| PostgreSQL canonical names and lock contention within those groups | **83 add + 83 edit cases**, **6 concurrency cases** passed |
| Syntax, protocol-copy equality, original inline script, inert configuration and diff checks | Passed |

The browser fixture delivers an unusable response after committing to model
lost confirmation without Chromium transparently retrying a closed socket.
Another case reloads with the response still in flight. Fixture cleanup closes
its owned HTTP connections so an interrupted request cannot hang teardown.
Historical results in the following sections describe earlier revisions,
not the current source.
Provenance retains those baselines and fingerprints this implementation
separately. No design deviation: the namespace/lock are retained, the protocol
is extended rather than replaced, and legacy reconciliation stays SELECT-only.

### Remaining acceptance work

This is an implementation GO, **not a deployment GO**. Live disposable
Supabase Auth/PostgREST/schema-cache/Realtime and two-account/iPhone acceptance
are still required with a separately approved test configuration. The sanitized
runner remains stop-on-failure evidence, not a newly activated live target;
its complete workflow is not automatically resumed after a reload.

Storage deletion/eviction, browser-profile loss, old running tabs and manual
receipt edits remain outside the durability guarantee. Web Locks coordinate
only cooperating same-origin tabs, not devices. Import markers track the latest
local snapshot per caller/list, not global or perpetual import deduplication.
Lost receipts/markers must not be treated as permission to recreate uncertain
groceries. Legacy absent/changed/inaccessible rows need manual review; revoked
membership can deliberately leave recovery blocked. Unknown server errors also
stay pending. Ledger retention and backup/restore consistency remain unresolved.
Invitation redemption still uses its existing non-ledger API; legacy database
writes still bypass the ledger. No permission cutover is included.

## Historical pending-request recovery fix (`072cb66`, review only)

At `072cb66`, `client/shared.js` included a fix on top of recovery commit
`353988b`; it was no longer unchanged recovered source. The recovery narrative and
verification below describe that baseline. `provenance.json` retains the original
source hash and records the modified file separately from its recovery evidence.

`protectedRequest()` now resolves a pending receipt after a confirmed permanent
rejection. It uses the existing receipt format (`state: 'confirmed'` with
`result.status: 'rejected'`) to release the pending gate while retaining the
request ID for inspection. It still reports the original error, preserves form
input, and does not automatically retry. A later mutation receives a fresh ID.

Classification requires a structured HTTP 4xx response (excluding 408/429) plus
a PostgreSQL data/constraint error (SQLSTATE classes 22/23), permission denial
(`42501`), or an exact known validation/access rejection from the 002/003 RPCs
(`P0001`). Unknown errors, transport failures, timeouts, gateway responses,
malformed successes, unavailable/incomplete ledger results, and request-ID
payload mismatches retain the original pending receipt for replay or review.
The error message alone, or a generic HTTP status alone, cannot clear it.
Failure to persist the rejection also leaves the pending receipt intact.

Validation on Node 24.19.0:

```sh
node --test tests/*.test.cjs reviews/shared-client-recovery-2026-10-19/verify-offline.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
```

**133 Node tests passed, 0 failed**, including 31 new recovery tests, the existing
five recovery checks, parser/name-validation regressions, and the local-app
Chromium workflow. **13 Python restore-validator tests passed, 0 failed.**
JavaScript syntax and `git diff --check` also passed.

The new suite executes the actual shared client and protocol with in-memory DOM,
storage and RPC substitutes, including a mock ledger that commits before losing
its response. It proves later mutations are unblocked after rejection, exact-ID
replay survives reload without a second effect, conflicts remain confirmed, and
storage/session changes fail closed. Three cases exercise the bundled Supabase
SDK with fake fetch responses; none contacts a backend. This is not a new live
database/concurrency, shared-client browser, Auth, or iPhone integration result.
Unknown/new rejection codes intentionally remain pending until classified or
reviewed. The sanitized historical runner is unchanged and does not gain this
shared-client fix. All other readiness blockers below remain open.

## Original recovery record

Recovered October 19, 2026 from the historical cloud chat **Set up grocery-app**
(`01a14a9c-e1f3-75c4-8035-332a49c5f036`, host `durable`), repository history, and
the previously downloaded Mac runner artifacts. Existing application files and
the recovered database records were not overwritten or changed.

**The runtime source is complete enough to begin offline/mock integration review.
It is a reconstructed candidate, not an authenticated original release or a
deployment-ready package.** No unresolved implementation sections or secret-redaction markers
remain in the reconstructed runtime source. Active configuration is deliberately
replaced by empty review placeholders; historical runner identifiers are sanitized, and the historical end-to-end test harness
has not been recovered. No app/server/runner was started against any backend.

## Contents and confidence

| Path | Classification and evidence |
| --- | --- |
| `client/shared.js` | Originally a complete 526-line reconstruction matching the final 9,141-byte source-read prefix and all 15 final line-numbered call sites. Now modified by the pending-request recovery fix above. No original complete-file hash is available. |
| `client/mutation-protocol.js` | Exact decoded text of the complete later file-read output; also matches the creation record. This is stronger than reconstruction but still not proof of original disk bytes/line endings. |
| `client/index.html` | Reconstructed from committed `a01bd5a:index.html` plus recorded shared UI, accessibility, protocol-script, and pending-operation-button edits. Its original local application inline script remains byte-for-byte equal to that Git baseline. |
| `client/vendor/supabase-2.118.0.js` and license | Copied unchanged from the available Mac artifact. Its embedded version is 2.118.0 and it matches the downloaded ZIP. No current npm-registry integrity verification was performed. |
| `client/grocery_app_icon.png` | Existing committed application asset, copied unchanged to satisfy the recovered HTML references. |
| `runner/runner.js` | Complete reconstruction: existing Mac runner plus the recorded replay-protocol upgrade. The older baseline matches the available 11,900-character cloud-read prefix and the local ZIP. The reconstruction matches all 15 later recorded runner call sites, including their line numbers. The account literals were subsequently sanitized as documented below. |
| `runner/grocery-live-validation.py` | Existing Mac helper matches its complete earlier cloud-read text; recorded protocol serving/HTML-wiring changes were then applied as data. The project/account literals were subsequently sanitized as documented below. Python source was parsed, not executed. |
| `runner/mutation-protocol.js`, `supabase.js`, license | Identical copies of the protocol and SDK supplied with the client. |
| `runner/START-HERE.txt` | Existing local instructions plus the recorded protocol-update appendix. Historical instructions are evidence, not authorization to run the helper. |
| `tools/build-validation-bundle.recovered.py` | Complete source extracted from the recorded creation command. Reference only: it expects the old repository layout, not this review-directory layout. It was not executed. |
| `client/shared-config.js`, `runner/public-config.json` | **New inert placeholders, not recovered configuration.** URL and publishable-key fields are empty. No production key was copied into these files. |
| `verify-offline.cjs` | **New recovery verification**, not a recovered historical test suite. Uses only in-memory substitutes, with no network, browser, server, database, or migrations. |
| `provenance.json` | Per-file hashes, source identities, evidence and transformation classifications. Hashes fingerprint this recovery, not an original release. |

## Reconstruction boundaries

The source was recovered by decoding command representations and interpreting a
small allowlist of string operations and virtual-file reads/writes. Historical
shell commands, Python scripts, database commands, authentication flows, cleanup
commands and deployment instructions were **not executed**. No historical code
was evaluated to perform reconstruction.

Two sections of `shared.js` could not be reproduced correctly by simply applying
the edits in the retrieved item order. They were reconciled using recorded source,
not invented replacements:

1. **Session-error handling**, near lines 15–25: the explicit replacement in
   `exec-497c3377-2fe8-4a8c-ad3a-3bc39867d3cb` is confirmed by the later final
   file-read prefix. It restores the visible session-error message and failure flag.
2. **`finishReceipt`**, near lines 351–368: copied as a complete function from
   `exec-e9fc7ee1-7f10-4d8d-917a-935e6bb90b78`, including its captured receipt key.
   This also restores the final call-site line positions recorded later.

The initial shared-client creation record had a redaction marker in its obsolete
direct invitation handler. The later recorded edit replaces that entire handler
with the protected invitation RPC; the final recovered file contains no residual
redaction or guessed invitation expression. No redacted authentication material
was recovered or required.

The latest available client review is cloud turn
`01a14edd-695a-72bb-bf7d-dabd9d1cc60e`. Its subsequent available turns concern
database verification, with no later client edit identified. This establishes
the latest reconstructable version in the inspected records; it cannot rule out
unrecorded later edits or establish which version was deployed.

## Sanitization for Git preservation

The two runner files are **sanitized reconstructions**, not unchanged historical
files. Their production project address and personal account addresses were
replaced with `https://grocery-review.invalid`, `account-1@example.invalid`, and
`account-2@example.invalid`. The `.invalid` values are deliberate non-operational
placeholders; no real account or project is represented. Inline comments identify
the replacements. The comparison guards and CSP construction remain in place,
and both active configuration files still contain empty URL/key fields.

These substitutions preserve line counts and mutation code. The manifest records
the pre-sanitization hashes, transformation descriptions and current hashes;
original sensitive literals are not repeated in the notes. The historical
`START-HERE.txt` and bundle builder remain reference evidence only: their original
layout/run instructions do not make this package ready to execute. A separately
reviewed disposable-test adapter and configuration are still required.

Raw historical records, test-run state, logs, generated SQL and machine-specific
helpers remain under ignored `.restore-validation/`. Python caches and environment
files are excluded by the repository's existing ignore rules. Do not force-add
those local artifacts when preserving this package.

## Verification performed

Run the new offline checks from the repository root:

```sh
node --test reviews/shared-client-recovery-2026-10-19/verify-offline.cjs
```

**5 tests passed, 0 failed:** HTML IDs and dependency order; shared-module
initialization and handler registration; actual recovered protocol routing and
pending receipts; matching client/runner SDK and protocol bytes with empty
configuration and sanitized runner identifiers; and upgraded runner call sites
and protocol serving.

The protocol test uses a fake RPC receiver. It verifies call shapes and receipt
handling, not database effects. The shared-module startup uses a minimal in-memory
DOM; it does not establish browser rendering or complete event-flow correctness.

Additional checks passed:

- JavaScript syntax checks for the recovered shared client, protocol and runner.
- Python syntax parsing for the runner and historical bundle-builder source.
- Exact later protocol read, shared-source prefix and both final numbered
  call-site inventories.
- Original local app script unchanged; all HTML IDs and local runtime assets present.
- No unresolved secret-redaction markers in final runtime code.

Playwright and jsdom were unavailable in the current Node environment. No real
browser/end-to-end suite was run. Prior passing database results are separate
evidence, not a test of this reconstructed package against a database.

## Missing material and requirements before integration

1. **Original release identity remains missing.** There is no original complete
   final `shared.js`/HTML/runner hash or commit. Review and explicitly adopt this
   candidate before treating it as an integration baseline.
2. **Test configuration is intentionally missing.** The client refuses shared
   startup with the supplied empty configuration. Supply only an approved
   disposable test target in a separate working copy; do not copy production
   credentials or activate the historical configuration.
3. **The runner is sanitized evidence, not a runnable test target.** Its project
   and expected-account checks now use explicit `.invalid` placeholders. Empty
   configuration prevents startup. A separately reviewed test-target adapter and
   synthetic identities are needed before using it against disposable Supabase.
   Do not populate this evidence copy with production configuration.
4. **The historical test harness is not included.** Browser fixtures, original
   integration tests, and their complete prerequisite environment must be
   recovered or independently rebuilt. The five new checks are not substitutes.
5. **Database/platform setup is not bundled or executed.** The app requires the
   existing baseline/002 plus the corrected 003 proposal. A separate approved
   isolated setup must supply Auth and invitation behavior; review 004 separately.
6. **Known client gaps are preserved.** Adds/imports still use direct INSERT with
   stable-ID receipts, invitation redemption uses the existing non-ledger RPC,
   and legacy write-path cutover remains unresolved. The pending-rejection blocker
   is addressed by the review fix above; unknown outcomes still remain pending.
7. **Runtime acceptance remains outstanding.** Test the exact candidate's Auth,
   PostgREST, Realtime, invitations, lost-response replay, imports, multiple tabs,
   recovery behavior, and two-device/iPhone Safari/Home Screen flows.

Outcome: the client and runner source can now be reviewed and exercised with
offline mocks without inventing missing runtime sections. A complete live
integration run still requires an approved disposable test configuration,
runner adaptation and a test harness. Production deployment remains NO-GO.

No production connection, migration, container operation, commit, push, merge,
or deployment was performed during recovery.
