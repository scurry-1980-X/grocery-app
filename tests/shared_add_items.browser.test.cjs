const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.join(__dirname, '../reviews/shared-client-recovery-2026-10-19/client');
const caller = '11111111-1111-4111-8111-111111111111';
const list = '22222222-2222-4222-8222-222222222222';
const secondList = '33333333-3333-4333-8333-333333333333';
const mutationKey = `grocery-mutation-v1:${caller}`;
const marker = `grocery-imported-v1:${caller}:${list}`;

// Actual recovered HTML, inline parser, shared.js and protocol. Only the SDK
// transport/auth are simulated. All HTTP is loopback; no backend or SQL runs.
function installTransport({ caller, list, secondList }) {
  const user = { id: caller, email: 'fixture@example.invalid', is_anonymous: false };
  const session = { user, access_token: 'browser-fixture-token' };
  window.supabase = { createClient(_url, _key, options) {
    return {
      auth: { getSession: async () => ({ data: { session } }), getUser: async () => ({ data: { user } }),
        onAuthStateChange() {}, signOut: async () => ({ error: null }) },
      async rpc(name, args) {
        const token = options.accessToken ? await options.accessToken() : session.access_token;
        const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${token}` }, body: JSON.stringify({ name, args }) });
        const data = await response.json();
        return response.ok ? { data, error: null, status: response.status } : { data: null, error: data, status: response.status };
      },
      from(table) {
        const query = { table, target: list, ids: null,
          select() { return this; }, eq(key, value) { if (key === 'list_id') this.target = value; return this; },
          order() { return this; }, range() { return this; }, in(_key, ids) { this.ids = ids; return this; },
          insert() { throw new Error('Direct INSERT forbidden'); },
          then(resolve, reject) {
            if (this.table === 'grocery_list_members') return Promise.resolve({ data: [{ list_id: list }, { list_id: secondList }], error: null }).then(resolve, reject);
            return fetch('/rows?list=' + this.target + (this.ids ? '&ids=' + this.ids.join(',') : ''))
              .then(async response => response.ok ? { data: await response.json(), error: null }
                : { error: { message: 'Read unavailable' }, status: response.status }).then(resolve, reject);
          },
        }; return query;
      },
      channel() { return { on() { return this; }, subscribe() { return this; } }; }, removeChannel() {},
    };
  } };
}

async function fixture(t) {
  const state = { rows: new Map(), ledger: new Map(), calls: [], loseOnce: false, deny: false, failRead: false };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/rpc') {
        assert.equal(req.headers.authorization, 'Bearer browser-fixture-token');
        let body = ''; for await (const chunk of req) body += chunk;
        const { name, args } = JSON.parse(body); state.calls.push(args);
        assert.equal(name, 'mutate_grocery_once'); assert.equal(args.operation, 'add_items');
        if (state.deny) { res.writeHead(400).end(JSON.stringify({ code: 'P0001', message: 'You are not a member of this grocery list' })); return; }
        let saved = state.ledger.get(args.request_id);
        if (!saved) {
          const items = args.payload.items.map(row => ({ ...row, id: String(row.id), list_id: args.target_list_id,
            owner_id: caller, revision: crypto.randomUUID(), created_at: new Date().toISOString() }));
          saved = { status: 'ok', items }; state.ledger.set(args.request_id, saved);
          for (const row of items) state.rows.set(row.id, { ...row });
          if (state.pauseResponse) {
            await new Promise(resolve => { state.releaseResponse = resolve; state.onCommit(); });
          }
          if (state.loseOnce) {
            state.loseOnce = false;
            // Deliver an unusable response AFTER committing. Destroying a reused
            // socket before headers lets Chromium transparently retry the POST.
            res.writeHead(200, { 'Content-Type': 'application/json' }).end('{'); return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(saved)); return;
      }
      if (url.pathname === '/rows') {
        if (state.failRead) { res.writeHead(503).end('{}'); return; }
        const ids = url.searchParams.get('ids')?.split(',');
        const rows = [...state.rows.values()].filter(row => row.list_id === url.searchParams.get('list') && (!ids || ids.includes(row.id)));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rows)); return;
      }
      if (url.pathname === '/shared-config.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' }).end("window.GROCERY_SHARED_CONFIG={url:'https://grocery-review.invalid',publishableKey:'sb_publishable_fixture'};"); return;
      }
      const asset = { '/': 'index.html', '/shared.js': 'shared.js', '/mutation-protocol.js': 'mutation-protocol.js',
        '/grocery_app_icon.png': 'grocery_app_icon.png' }[url.pathname];
      if (!asset) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': asset.endsWith('.js') ? 'application/javascript' : asset.endsWith('.png') ? 'image/png' : 'text/html' })
        .end(await fs.readFile(path.join(root, asset)));
    } catch (error) { res.writeHead(500).end(JSON.stringify({ message: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => state.releaseResponse?.());
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const url = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
  await context.addInitScript(installTransport, { caller, list, secondList });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  t.after(() => assert.deepEqual(errors, []));
  async function open(page = null) {
    page ||= await context.newPage(); await page.goto(url);
    await page.locator('#shared-mode-button').click();
    await page.waitForFunction(() => document.getElementById('signed-in-as').textContent.includes('fixture@'));
    await page.waitForFunction(() => !document.getElementById('refresh-lists').disabled);
    return page;
  }
  return { state, context, open, url };
}
const waitIdle = page => page.waitForFunction(() => !document.getElementById('refresh-lists').disabled);
async function submit(page, name, quantity = '1') {
  await page.locator('#cloud-name').fill(name); await page.locator('#cloud-quantity').fill(quantity);
  await page.locator('#cloud-submit').click(); await waitIdle(page);
}
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), mutationKey);

test('shared browser single/multi adds and purchased import use one RPC per batch', async t => {
  const { state, open } = await fixture(t); const page = await open();
  await submit(page, 'Milk'); await submit(page, '2 apples, bread', '3');
  assert.equal(state.calls.length, 2); assert.equal(state.calls[1].payload.items.length, 2);
  assert.deepEqual(state.calls[1].payload.items.map(row => [row.item_name, row.quantity]), [['apples', 2], ['bread', 3]]);
  const source = JSON.stringify([{ name: 'Eggs', quantity: 6, done: true }]);
  await page.evaluate(source => localStorage.setItem('my-groceries-v1', source), source);
  page.on('dialog', dialog => dialog.accept()); await page.locator('#cloud-import').click(); await waitIdle(page);
  assert.equal(state.calls.length, 3); assert.equal(state.calls[2].payload.items[0].purchased, true);
  assert.equal(await page.evaluate(key => localStorage.getItem(key), marker), source);
  assert.equal(await page.evaluate(() => localStorage.getItem('my-groceries-v1')), source);
  await page.locator('#cloud-import').click(); await waitIdle(page); assert.equal(state.calls.length, 3);
  assert.match(await page.locator('#cloud-status').textContent(), /already imported/);
  assert.equal((await saved(page)).state, 'confirmed');
});

test('shared browser reload retries original request after commit, edit/delete, and access denial', async t => {
  const { state, open } = await fixture(t); let page = await open(); state.loseOnce = true;
  await submit(page, 'Milk, Bread'); const original = await saved(page);
  assert.equal(original.state, 'pending'); assert.equal(await page.locator('#cloud-submit').isDisabled(), true);
  state.rows.clear(); state.deny = true;
  page = await open(page); await page.locator('#check-pending').click(); await waitIdle(page);
  assert.deepEqual(await saved(page), original); assert.equal(state.ledger.size, 1);
  state.deny = false; await page.locator('#check-pending').click(); await waitIdle(page);
  assert.equal((await saved(page)).state, 'confirmed'); assert.equal(state.rows.size, 0);
  assert.deepEqual(state.calls[0], state.calls[1]); assert.deepEqual(state.calls[0], state.calls[2]);
});

test('reload while the server response is still pending preserves the original intent', { timeout: 30000 }, async t => {
  const { state, open } = await fixture(t); const page = await open();
  const committed = new Promise(resolve => { state.onCommit = resolve; });
  state.pauseResponse = true;
  await page.locator('#cloud-name').fill('In flight');
  await page.locator('#cloud-submit').click(); await committed;
  const original = await saved(page); assert.equal(original.state, 'pending');
  await open(page);
  assert.deepEqual(await saved(page), original);
  state.releaseResponse();
  await page.locator('#check-pending').click(); await waitIdle(page);
  assert.equal((await saved(page)).state, 'confirmed');
  assert.equal(state.ledger.size, 1); assert.equal(state.rows.size, 1);
  assert.deepEqual(state.calls[0], state.calls[1]);
});

test('real Web Locks serialize tabs and preserve an uncertain request; storage events gate the other tab', async t => {
  const { state, open } = await fixture(t); const first = await open(), second = await open();
  await first.locator('#cloud-name').fill('One'); await second.locator('#cloud-name').fill('Two');
  // Hold the real shared lock so both submit handlers queue before either sends.
  await first.evaluate(caller => {
    window.lockHeld = false;
    navigator.locks.request(`grocery-write:${caller}`, async () => {
      window.lockHeld = true; await new Promise(resolve => { window.releaseLock = resolve; });
    });
  }, caller);
  await first.waitForFunction(() => window.lockHeld);
  state.loseOnce = true;
  await Promise.all([first.locator('#cloud-submit').click(), second.locator('#cloud-submit').click()]);
  await first.evaluate(() => window.releaseLock());
  await Promise.all([waitIdle(first), waitIdle(second)]);
  assert.equal(state.calls.length, 1); assert.equal(state.ledger.size, 1);
  assert.deepEqual(await saved(first), await saved(second));
  assert.equal(await first.locator('#cloud-submit').isDisabled(), true);
  assert.equal(await second.locator('#cloud-submit').isDisabled(), true);
  await second.locator('#check-pending').click(); await waitIdle(second);
  assert.equal(state.ledger.size, 1); assert.deepEqual(state.calls[0], state.calls[1]);
});

test('real browser mixed legacy/RPC recovery remains reachable on an unselected list', async t => {
  const { state, open } = await fixture(t); const page = await open(); state.loseOnce = true;
  await submit(page, 'New RPC');
  const legacy = { state: 'pending', kind: 'add', records: [{ id: -42, item_name: 'Legacy', quantity: 1,
    purchased: false, list_id: secondList, owner_id: caller }] };
  await page.evaluate(({ caller, target, receipt }) => localStorage.setItem(`grocery-save-v1:${caller}:${target}`, JSON.stringify(receipt)),
    { caller, target: secondList, receipt: legacy });
  await open(page);
  assert.equal(await page.locator('#check-pending').isVisible(), true);
  assert.equal(await page.locator('#check-legacy').isVisible(), true);
  await page.locator('#check-legacy').click(); await waitIdle(page);
  assert.equal(state.calls.length, 1); assert.match(await page.locator('#cloud-status').textContent(), /still unconfirmed/);
  state.rows.set('-42', { ...legacy.records[0], id: '-42' });
  await page.locator('#check-legacy').click(); await waitIdle(page);
  assert.equal(state.calls.length, 1); assert.equal((await saved(page)).state, 'pending');
  await page.locator('#check-pending').click(); await waitIdle(page);
  assert.equal((await saved(page)).state, 'confirmed'); assert.equal(state.calls.length, 2);
});

test('browser storage blocks a new send and post-commit refresh failure does not reopen the add', async t => {
  const { state, open } = await fixture(t); let page = await open();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage blocked'); }; });
  await submit(page, 'Unsaved'); assert.equal(state.calls.length, 0);
  assert.equal(await page.locator('#cloud-name').inputValue(), 'Unsaved');
  page = await open(page); state.failRead = true;
  await submit(page, 'Saved'); assert.equal(state.calls.length, 1); assert.equal((await saved(page)).state, 'confirmed');
  assert.match(await page.locator('#cloud-status').textContent(), /saved.*Refresh failed/i);
  assert.equal(await page.locator('#cloud-name').inputValue(), '');
  assert.equal(await page.locator('#cloud-submit').isDisabled(), true);
});
