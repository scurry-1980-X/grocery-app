# Release blocker remediation — Phase 1

Base: `kindredbasket-integration` at `167d22b`.
Branch: `codex/reliability-phase-1`.

## Changes

- Edit targets and row mutations use immutable item IDs. Each form draft has a
  revision; late saves cannot reset a newer draft, a cancelled edit, or another
  item's edit. An item removed remotely leaves its draft visible with an error.
- One form submission may be in flight at a time. Both the button and event
  handler enforce this, including repeated Enter/programmatic submit events.
- Concurrent removals reconcile by acknowledged IDs. Per-item locks prevent
  overlapping writes to the same row. Clear Purchased snapshots its target IDs,
  reconciles only acknowledged removals, and preserves unrelated drafts.
- Reads distinguish loading, empty, failed and stale states. Failed reads preserve
  the last loaded list, pause writes, display an alert, and offer a retry button.
- Insert/update/delete requests ask the server to return affected rows. Missing,
  empty or unexpected acknowledgements do not count as a successful save. Failures
  and exceptions display accessible errors and keep the current draft.
- Only reads are retried automatically through the existing Realtime refresh flow.
  A failed write requests reconciliation but is never automatically repeated.

No migrations, RLS changes, new dependencies, credentials or legacy-data import
behavior were added. Existing invitation/authentication code and Realtime
subscription are retained. This phase changes the handling of remote deletion
while editing: the draft is preserved rather than discarded.

## Tests

Using an existing Playwright installation and Chromium/Chrome executable:

```sh
export PLAYWRIGHT_PATH=/path/to/playwright-core
export BROWSER_PATH=/path/to/chrome
node tests/reliability.cjs
node tests/shopping-mode.cjs
node tests/autocomplete.cjs
```

The reliability suite covers delayed saves, cancel/edit switching, duplicate
submit events, new drafts and autocomplete during writes, both delete-response
orders, initial/background read errors, retries, zero/missing acknowledgements,
transport exceptions, lost insert responses, partial bulk deletes and remote
removal of an edited item. It runs at 320px and 390px touch viewports. Existing
Shopping Mode tests run at 320/390/430px; autocomplete runs at 390px. Services are
mocked and external requests intercepted. Syntax and whitespace checks also run.

For regression proof, `APP_HTML` can point to the base branch's HTML, with
`CASE_PATTERN` and `TEST_WIDTHS` selecting representative cases. Baseline failures
must correspond to the audit bugs, not fixture or launch errors.

Validation completed: all 54 reliability scenarios passed (27 at each width),
as did the Shopping Mode and autocomplete suites, JavaScript syntax checks and
`git diff --check`. Selected tests against the unchanged `167d22b` HTML reproduced
the cancel/save exception, wrong-row edit, duplicate inserts, stale-index removal
and missing write-error feedback. The fixed branch passed those same scenarios.

## Limits and remaining release gates

- Live Supabase authorization, household isolation, RPC permissions and invitation
  atomicity have not been validated. Returned mutation rows require suitable
  SELECT access as well as mutation permission; verify this with actual members.
- A request can commit while its acknowledgement is lost. The client preserves
  the draft and refreshes, asking the user to check before retrying. It cannot
  guarantee exactly-once inserts across manual retries, reloads or devices without
  an approved backend idempotency mechanism. It does not queue offline writes.
- A successful empty read does not establish household membership. Stale list IDs,
  revoked membership and anonymous-account recovery still need a separate design.
- Conflicting edits from different clients still use the existing last-writer
  behavior; this phase fixes local async identity/draft races, not server versioning.
- A refreshed list is only as complete as the existing server query/row limit.
- Physical iPhone/iPad Safari and VoiceOver remain untested. Chrome touch emulation
  is not Safari. SDK pinning/startup recovery, contrast fixes, numeric-only parsing,
  deployment hardening and operational validation remain separate audit items.
- Legacy data migration remains unchanged and is still a release blocker. See
  [the proposed design](legacy-import-design.md), which requires product-owner
  approval and separate implementation.

These changes do not establish overall production readiness. Do not merge the
integration release into main or deploy until the outstanding gates are resolved.
