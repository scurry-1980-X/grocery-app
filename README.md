# Grocery App

A small grocery list for the browser. The stable app currently stores one list
locally on each browser/device. It does **not** yet share lists between Scott
and Sandy's iPhones.

## Architecture

- `index.html`: semantic HTML, responsive CSS, and plain JavaScript in one file.
- `grocery_app_icon.png`: favicon and Apple Home Screen icon.
- `tests/parser.test.cjs`: dependency-free Node regression tests that execute the
  actual page script with a minimal startup DOM, then exercise its parser.
- `tests/browser.test.cjs`: real Chromium regression test using Playwright already
  available in the development environment; no application dependency is added.
- `SHARED_LIST_PLAN.md`: reviewed prototype, integration plan and acceptance tests.

State is an array of `{ name, quantity, done }`. Rendering creates DOM elements
and assigns item names with `textContent`. Each successful action saves the array
in `localStorage` under `my-groceries-v1`. There is no backend, framework, package
installation, build step, or required secret. Storage belongs to the website
origin and browser; changing the host/port or clearing browser data can make a
list unavailable. No guaranteed offline loading or cross-tab synchronization is
implemented.

## Run locally

From the repository root, using Python 3:

```sh
python3 -m http.server 8000 --bind 0.0.0.0 --directory .
```

Open the server in your local browser. Stop with Ctrl-C. This is a development
server, not a production deployment. Cloud onboarding checks should use internal
HTTP requests and browser tests rather than publishing loopback preview links.

## Test

Use Node.js 20 or later (validated here with Node 24):

```sh
node --test tests/parser.test.cjs
```

For full browser coverage, the environment must also provide the `playwright`
Node module and Chromium. This cloud environment already does. Run:

```sh
node --test tests/*.test.cjs
```

The browser test starts and stops its own loopback HTTP server on an available
port and uses an isolated, disposable browser profile. It does not touch your
saved grocery list or any cloud service. Chromium defaults to
`/usr/bin/chromium`; override with `CHROMIUM_PATH` if needed. Its `--no-sandbox`
launch option is for the isolated cloud test container. On another machine,
provision Playwright and Chromium in the development environment if needed;
they are not runtime dependencies. Missing browser tooling is a failed
prerequisite, not a passing or silently skipped browser check.

Before release, also test actual iPhones: Safari and Home Screen launch,
keyboard/form behavior, small-screen layout, and reload persistence. Chromium's
phone-sized viewport does not establish iOS compatibility.

## Stable behavior

- Add one item or comma-separated items; surrounding whitespace and empty comma
  segments are ignored when at least one item remains.
- A whitespace-separated whole-number prefix overrides the Quantity field:
  `2 apples, milk` with Quantity 3 creates apples × 2 and milk × 3.
- Quantities must be 1–999. Zero, out-of-range, signed or decimal numeric
  prefixes are rejected. A bad batch adds nothing and remains editable, with a
  browser validation message. Correcting the Item field clears that message.
- Names such as `7up`, `123`, `2% milk`, and `2apples` remain literal names.
  Only comma separation and the documented numeric prefix syntax are supported;
  units, quoted commas, and natural-language interpretation are not supported.
- Edit name/quantity or cancel an edit. Editing treats the name literally,
  without splitting commas or interpreting quantity prefixes.
- Mark purchased/unpurchased, show remaining item count, remove an item, and clear
  only purchased items. Clear is disabled when nothing is purchased.
- Retain valid items after reload. Warn when storage cannot be read/written;
  in-memory actions remain possible, but unsaved changes are not durable.
- Restore focus after actions; provide labeled controls and a status region.

Known limits: no undo, account, backup, sharing, realtime updates, or durable
recovery after browser-data loss. Invalid stored records are filtered on load.
The icon supports Home Screen branding but does not itself make an offline PWA.

## Development and preservation

The pre-milestone stable baseline is commit `00c873c` on `main`. This milestone
keeps its local-storage key, data shape and application workflow. Preserve Git
history: use small reviewable commits and additive changes; do not reset or
force-push existing branches. Inspect old commits in Git without overwriting
uncommitted work. Future cloud tasks should use their existing isolated checkout;
no additional worktree is necessary unless requested.

Product decisions belong to Scott as product owner. Development work should
include implementation, regression checks and review, with major architecture
choices explained. Do not activate billing, paid services or subscriptions
without explicit approval. No service or deployment is introduced by this
milestone.
