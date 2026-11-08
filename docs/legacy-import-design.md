# Proposed legacy grocery import — product-owner approval required

Status: design only; not approved or implemented. Phase 1 does not read, migrate,
delete or alter the legacy `my-groceries-v1` list. This document is separate from
the client reliability fixes. No live database or policy changes were made.

## Recommended experience

1. Detect legacy data locally and offer **Review saved groceries**. Dismissal
   leaves the data untouched. Do not import on startup, sign-in, or invitation
   acceptance. Show the number of valid entries and any entries needing repair.
2. Let the user preview every item, quantity and purchased state. Keep duplicate
   rows as separate entries by default; names alone are not reliable identities.
   Preserve existing integer quantities 1–999, including quantities above the
   new-item dropdown's range. Never silently clamp quantities or discard invalid
   records. Offer a downloadable copy of the original data before import.
3. Require an explicit destination household selection, even if the user belongs
   to only one household. List only households authorized by the server, with a
   human-readable label and enough context to distinguish them. Do not silently
   choose the active household or the household from a newly opened invitation.
   Creating a new household should be a separate, deliberate choice.
4. Show a confirmation such as **Import 12 items into Smith household** with a
   warning that household members can see them. The confirmation is bound to the
   selected household and the previewed snapshot. Navigation, a changed source,
   an identity change, or a new invitation invalidates an unsubmitted confirmation.
5. Keep the original local data after a confirmed import. Show a receipt with the
   destination and imported count. Deleting the local backup is an optional,
   separate action; an import must never do it automatically.

Household names/membership enumeration are not defined in the current repository.
The implementation must inspect the actual schema and authorized APIs before
choosing an identifier, display label or query. Do not infer membership from an
empty item list or a browser-supplied household ID.

## Safe retries and non-destructive behavior

- Persist a frozen source snapshot and import operation ID before the first write.
  Bind the plan to the authenticated user, explicit target household, source
  fingerprint and per-entry identities. Keep original row order and distinguish
  duplicate legacy rows by their source position/identity, not their names.
- Prefer a server-side import operation with an idempotency ledger. Authorize
  membership on the server and insert both the rows and the completed receipt in
  one transaction. A unique operation key must prevent duplicate insertion when
  the same request is retried or submitted from two tabs. The target and source
  fingerprint for an existing operation must be immutable.
- On timeout or a lost response, retain the snapshot and operation ID. Read the
  operation status. If completed, display the original receipt; if retryable,
  retry the same operation ID. Never generate a new ID merely because a response
  was lost. A status lookup must not expose another user's import or household.
- If a request committed but the user subsequently loses household access, do not
  import into a replacement household or expose protected receipt content. Explain
  the access change and require explicit recovery/reconfirmation.
- Persisted client bookkeeping alone cannot guarantee exactly-once import. The
  current item API has no reviewed idempotency contract. Do not ship automatic
  retries until the server mechanism is approved, implemented and tested. If the
  database cannot support the proposed transaction, bring a partial-import design
  with per-entry acknowledgements back for approval; do not silently substitute it.
- If durable local storage is unavailable, offer export and postpone import until
  a recoverable operation can be established. Clearing browser identity/storage
  can defeat anonymous-account recovery; document that limit and consider account
  linking or a server-recoverable import plan before release.
- Do not merge with or overwrite existing household groceries. Import creates new
  rows. Repeated imports of the same snapshot into the same household should show
  the existing receipt by default, with any intentional second import requiring a
  separate product decision and explicit confirmation.
- Never put grocery contents, invitation tokens or credentials in telemetry.

This design likely requires a new server operation/ledger and corresponding
policies. Those changes require a separate implementation review and authorization;
they are not part of Phase 1 and have not been applied to live Supabase.

## Decisions requested from the product owner

| Decision | Recommendation |
|---|---|
| Destination | Mandatory explicit household selection and final confirmation; no default automatic import. |
| Existing household rows | Append new rows; no name-based merge or replacement. |
| Legacy purchased items | Preserve their purchased state and show them in the preview. |
| Duplicate source entries | Preserve distinct rows, with optional explicit user edits in the preview. |
| Invalid or unsupported entries | Keep original data; require repair or explicit exclusion before confirming. |
| Local backup retention | Retain indefinitely until a separate user-requested deletion. |
| Repeated identical import | Show the previous receipt rather than import again. |
| Recovery scope | Approve a server idempotency/status mechanism and decide whether anonymous-only recovery is sufficient. |

## Required acceptance evidence for the separate migration change

Test existing-browser upgrades, cancel/dismiss, explicit household selection,
joining a different household during preview, member revocation, two tabs,
offline/online, committed-but-lost responses, repeated retries, storage failures,
invalid source JSON, duplicate names, legacy quantities and purchased states.
Verify unchanged source data, exactly one destination copy per approved operation,
and no writes to an unselected household. Test authorization with independent
users and households against a nonproduction Supabase environment matching the
production policies. Complete physical iPhone Safari and VoiceOver checks.
