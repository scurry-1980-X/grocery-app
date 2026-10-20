# Shared Grocery App client recovery — review candidate only

## Pending-request recovery fix (review only)

The current `client/shared.js` includes a new fix on top of recovery commit
`353988b`; it is no longer unchanged recovered source. The recovery narrative and
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
