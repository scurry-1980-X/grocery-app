# KindredBasket smart autocomplete

Base: `kindredbasket-integration` at `dc3c40c`.
Review branch: `kindredbasket-smart-autocomplete`.

The add-item input suggests up to six names from the active shared list,
including purchased items. Matching ignores case and surrounding whitespace;
prefix matches sort before substring matches. Suggestions are deduplicated by
normalized name and omit names already entered earlier in a comma-separated batch.
Existing duplicate rows are left unchanged.

Tap an option or use Up/Down and Enter to complete the final entry. Selection
fills the input without submitting, preserving earlier entries, any typed quantity
prefix, and the quantity dropdown. Escape or moving focus closes the suggestions.
Editing retains its existing behavior without suggestions. List renders, including
Realtime reloads, refresh suggestions from the current in-memory list.

The UI uses 48px touch targets and an ARIA combobox/listbox. Names are rendered
as text. No migrations, packages, or Supabase changes are required.

## Validation

The repository had no existing test runner or tests. Added a browser regression
script using the cloud workspace's existing Playwright and Chromium installation:

```sh
PLAYWRIGHT_PATH=/opt/codex/cua_node/lib/node_modules/playwright-core node tests/autocomplete.cjs
```

Passed at a 390 × 844 touch viewport: case-insensitive matching, deduplication,
six-result limit, prefix ranking, empty/no-match inputs, keyboard navigation,
Escape/blur dismissal, touch completion, comma-separated entry with typed and
dropdown quantities, all 100 quantity options, refreshed suggestion data through
the Realtime callback, edit/cancel, invitation creation, and no horizontal overflow
or browser script errors. `git diff --check` also passed.

Supabase is mocked in the browser test: it verifies client integration behavior,
not live authentication, invitation redemption, RLS, or cross-device transport.
No live service writes, merges, or deployments were performed.
