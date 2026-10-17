# Shared list integration plan

## Reviewed state

Reviewed `main` at `00c873c` and remote `shared-grocery-list` at
`e235e407948619d5e9ce627a827dd63d3bcee4d0`. The remote branch source and GitHub
comparison were read without checking it out or changing local Git refs.

History on main: executable/accessibility restoration (`968805b`), Home Screen
icon (`3ce9087`), editing (`7250642`), multi-item parser (`0e700f8`) and default
quantity correction (`b5b3380`), merged at `00c873c`.

The shared branch comparison is based on the earlier editing version. It adds a
Supabase JS v2 CDN import, configured project URL and publishable browser key,
anonymous auth, `create_grocery_list` RPC, a locally remembered list ID, initial
item loading, cloud inserts/edits/deletes and purchased updates. It also adds an
unused shared icon and a `.gitignore` entry for `tempvalues.rtf`.

This is a prototype, not a validated shared application. No backend schema,
migrations, RPC definitions, access policies or deployment instructions appear
in the reviewed branch comparison. External Supabase configuration may exist;
its contents, billing status and live correctness were not verified. No live
auth, RPC or data mutations were performed during this review.

## Gaps and integration hazards

- Each new browser creates a separate list; no invite/join mechanism exists.
- No realtime subscription, polling or reconnect refresh exists.
- Clear purchased still changes only local state, so cloud records reappear.
- Main's multi-item parser is absent; replacing main loses that functionality.
- Local groceries are no longer loaded, with no explicit migration/import.
- Anonymous identity has no recovery path if storage is cleared or a phone changes.
- Auth/list failures do not gate the UI; some paths can use a missing session.
- Purchased updates alter local state before confirmation without rollback.
  Add failures can clear the input. Most errors only reach the console.
- Async handlers still rely on array indices and permit overlapping operations;
  delayed responses and remote edits need stable IDs and explicit handling.
- Reads have no explicit ordering; mutations rely on database policies for access
  control. Those policies and list membership must be verified, not assumed.
- The device-only storage note is inaccurate for the cloud version.
- The SDK major-version CDN URL is not reproducibly pinned to an exact version.

A publishable browser key is expected in a Supabase client. It is not a substitute
for row-level security. Never put a service-role/admin key in the browser.

## Safest strategy

Keep the stable local app and this regression suite as the foundation. Do not
replace `index.html` with the shared branch or blindly merge its prototype.
Bring forward the useful Supabase concepts in small commits on top of current
stable behavior, retaining the original branch/history for reference.

1. Inspect the existing project's configuration with authorized access. Record
   schema, RPC behavior, membership, policies, current hosting and plan limits.
   Verify a no-cost route before activating anything; seek approval for any cost.
2. Add versioned SQL migrations and reproducible setup instructions. Use lists,
   list memberships and items with stable IDs, constraints and deterministic
   ordering. Enforce membership on all reads/writes. Test with two members and an
   unrelated user; list IDs alone must never grant access.
3. Agree on a simple invitation and identity recovery flow. Evaluate retaining
   anonymous auth with secure invitations versus recoverable sign-in. Do not
   assume copying a list ID grants the second phone membership. Invitation tokens
   should be unguessable, revocable/expiring and validated server-side.
4. Introduce a small storage boundary for load/add/edit/purchase/delete/clear.
   Keep a local implementation and explicit shared-mode opt-in during rollout.
   Keep parsing and UI behavior common to both; no frontend framework is needed.
5. Implement all shared operations with server confirmation, clear error messages
   and duplicate-submit protection. Use item IDs instead of array positions.
   Define conflict handling: detect stale edits with a revision and ask the user
   to reload/retry rather than silently overwriting another person's changes.
6. Subscribe to list-scoped database changes, refresh on reconnect and foreground
   resume, and reconcile from authoritative data. Start online-first: display
   connection state and prevent unconfirmed offline writes. Offline queues can
   be a separate milestone.
7. Offer a deliberate, retry-safe import of existing local groceries. Preserve
   the original local copy until server confirmation and prevent duplicate imports.
8. Review and validate before choosing a stable HTTPS host. Deployment, new
   accounts, billing and service activation are separate authorized actions.

## Next milestone and acceptance

Next: a private, online shared list for Scott and Sandy with reproducible backend
security and an explicit join flow, preserving all current grocery actions.

Required checks before release:

- Existing parser and browser regressions pass in local mode.
- Two separate authenticated browser contexts join the same list; each can add,
  edit, purchase/unpurchase, remove and clear purchased items. Both converge
  within a few seconds while connected, including after reload.
- Unrelated users cannot read/write that list or join without a valid invitation.
- Concurrent adds preserve both items; stale edits, edit/delete races and repeated
  taps cannot silently target a different item or resurrect deleted records.
- Network/auth failures preserve entered data and report unsaved state; reconnect
  and app resume load authoritative data without duplication.
- Import preserves local data and is safe to retry; session loss has a documented
  recovery or re-invitation path.
- Run the same acceptance flow on two actual iPhones, both Safari and Home Screen
  shortcuts, including lock/unlock, background/resume and connection loss.

Automated browser tests should use a separate test backend or controlled network
fixtures; mocks alone cannot prove database authorization. Never run destructive
checks against Scott and Sandy's real grocery list.
