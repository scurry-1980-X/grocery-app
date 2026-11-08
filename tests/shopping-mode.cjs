// Uses an existing Playwright installation and browser; no added dependencies.
// PLAYWRIGHT_PATH=/path/to/playwright-core BROWSER_PATH=/path/to/chrome node tests/shopping-mode.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const listId = '11111111-1111-1111-1111-111111111111';
const inviteToken = '22222222-2222-2222-2222-222222222222';
const seed = () => [
  { id: 'milk', item_name: 'Milk', quantity: 2, purchased: true, list_id: listId },
  { id: 'apples', item_name: 'Apples', quantity: 3, purchased: false, list_id: listId },
  { id: 'bread', item_name: 'Bread', quantity: 1, purchased: false, list_id: listId },
  { id: 'rice', item_name: 'Rice', quantity: 250, purchased: false, list_id: listId }
];

// Only the SDK import is mocked. Application startup, query construction, event
// handlers and the existing Realtime subscription/reload path run unmodified.
const sdk = `
export const createClient = () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }) },
  rpc: (name, args) => window.mockRpc(name, args),
  from: table => {
    const request = { table, operation: 'select', filters: [] };
    const query = {
      select: () => query,
      eq: (key, value) => { request.filters.push([key, value]); return query; },
      insert: payload => { Object.assign(request, { operation: 'insert', payload }); return query; },
      update: payload => { Object.assign(request, { operation: 'update', payload }); return query; },
      delete: () => { request.operation = 'delete'; return query; },
      then: (resolve, reject) => window.mockQuery(request).then(resolve, reject)
    };
    return query;
  },
  channel: name => ({ on: (type, filter, callback) => {
    window.subscription = { name, type, filter };
    window.realtimeEvent = callback;
    return { subscribe: status => { window.realtimeStatus = status; status('SUBSCRIBED'); } };
  } })
});`;

async function eventually(read, expected) {
  for (let i = 0; i < 100; i++) {
    const actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    await delay(25);
  }
  assert.deepEqual(await read(), expected);
}

async function run(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [], blockedRequests = [], calls = [];
  let rows = seed(), nextId = 0, failure = null, hold = null;
  const broadcast = async () => Promise.all(context.pages().map(page =>
    page.evaluate(() => window.realtimeEvent?.()).catch(() => {})));
  await context.exposeFunction('mockRpc', async (name, args) => {
    calls.push({ rpc: name, args });
    return { data: name === 'create_grocery_list_invite' ? inviteToken : listId, error: null };
  });
  await context.exposeFunction('mockQuery', async request => {
    calls.push(request);
    assert.equal(request.table, 'grocery_items');
    const matches = row => request.filters.every(([key, value]) => row[key] === value);
    if (request.operation === 'update' && hold) await hold;
    if (request.operation === 'update' && failure) {
      const kind = failure;
      failure = null;
      if (kind === 'throw') throw new Error('Simulated offline request');
      return { data: null, error: { message: 'Simulated rejection' } };
    }
    let data;
    if (request.operation === 'insert') {
      data = request.payload.map(row => ({ ...row, id: `new-${++nextId}` }));
      rows.push(...data);
    } else if (request.operation === 'update') {
      rows.filter(matches).forEach(row => Object.assign(row, request.payload));
    } else if (request.operation === 'delete') {
      rows = rows.filter(row => !matches(row));
    } else data = rows.filter(matches);
    if (request.operation !== 'select') void broadcast();
    return { data: data ? structuredClone(data) : null, error: null };
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://grocery.test' && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.hostname === 'esm.sh') return route.fulfill({ contentType: 'text/javascript', body: sdk });
    if (url.origin !== 'http://grocery.test') blockedRequests.push(url.href);
    return route.abort();
  });
  const openPage = async (suffix = '') => {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://grocery.test/${suffix}`);
    return page;
  };
  const page = await openPage();
  const row = id => page.locator(`#list > li[data-item-id="${id}"]`);
  const order = () => page.locator('#list > li').evaluateAll(nodes => nodes.map(node => node.dataset.itemId));
  const progress = () => page.locator('#shopping-progress').evaluate(node => [node.value, node.max]);
  try {
    await eventually(order, ['apples', 'bread', 'rice', 'milk']);
    assert.equal(await page.locator('#list-mode').getAttribute('aria-pressed'), 'true');
    await page.locator('#shopping-mode').tap();
    assert.equal(await page.locator('#shopping-mode').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#list-mode').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await progress(), [1, 4]);
    assert.equal(await page.locator('#status').textContent(), '3 of 4 items left to buy');
    for (const target of ['#shopping-mode', '#list-mode', '#list input', '#list button']) {
      for (const box of await page.locator(target).evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect(); return { width: box.width, height: box.height };
      }))) {
        assert.ok(box.width >= 44 && box.height >= 48, `${target} touch target at ${width}px`);
      }
    }
    assert.ok((await row('apples').boundingBox()).height >= 112);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `shopping-${width}.png`), fullPage: true });
    }

    // A second browser page consumes the same mocked service via the unchanged
    // Realtime callback; mode is local, while purchase state is shared.
    const second = await openPage();
    await second.locator('#list > li').first().waitFor();
    assert.equal(await second.locator('#list-mode').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => window.subscription), {
      name: `grocery-items:${listId}`, type: 'postgres_changes',
      filter: { event: '*', schema: 'public', table: 'grocery_items' }
    });
    await row('apples').locator('input').tap();
    await eventually(order, ['bread', 'rice', 'milk', 'apples']);
    await eventually(() => second.locator('#shopping-progress').evaluate(node => node.value), 2);
    assert.deepEqual(await progress(), [2, 4]);
    await eventually(() => row('apples').locator('input').isEnabled(), true);
    assert.equal(await row('apples').locator('input').evaluate(node => node === document.activeElement), true);
    await row('apples').locator('input').press('Space');
    await eventually(order, ['apples', 'bread', 'rice', 'milk']);
    await eventually(() => second.locator('#shopping-progress').evaluate(node => node.value), 1);

    // Failure must restore the row, count and progress, for both SDK errors and exceptions.
    for (const kind of ['error', 'throw']) {
      failure = kind;
      await row('bread').locator('input').tap();
      await eventually(() => page.locator('#purchase-error').textContent(), 'Could not update purchase status. Please try again.');
      await eventually(() => row('bread').locator('input').isEnabled(), true);
      assert.equal(await row('bread').locator('input').isChecked(), false);
      assert.deepEqual(await progress(), [1, 4]);
      assert.deepEqual(await order(), ['apples', 'bread', 'rice', 'milk']);
    }

    // Optimistic sorting, repeated-tap prevention, and no focus theft while a write is pending.
    let release;
    hold = new Promise(resolve => { release = resolve; });
    await row('bread').locator('input').tap();
    await eventually(() => row('bread').locator('input').isDisabled(), true);
    assert.deepEqual(await order(), ['apples', 'rice', 'milk', 'bread']);
    assert.deepEqual(await progress(), [2, 4]);
    assert.equal(await page.locator('#clear').isDisabled(), true);
    await page.locator('#name').fill('Draft');
    release(); hold = null;
    await eventually(() => row('bread').locator('input').isEnabled(), true);
    assert.equal(await page.locator('#clear').isEnabled(), true);
    assert.equal(await page.locator('#name').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#name').inputValue(), 'Draft');

    // Sorting must not change which item Edit/Remove operate on; legacy quantities survive.
    await row('milk').locator('.edit').tap();
    assert.equal(await page.locator('#quantity').inputValue(), '2');
    await page.locator('#name').fill('Whole milk');
    await page.selectOption('#quantity', '100');
    await page.locator('#submit-button').tap();
    await eventually(() => row('milk').locator('.item').textContent(), 'Whole milk × 100');
    assert.equal(rows.find(item => item.id === 'apples').item_name, 'Apples');
    await row('rice').locator('.edit').tap();
    assert.equal(await page.locator('#quantity').inputValue(), '250');
    await page.locator('#name').fill('Brown rice');
    await page.locator('#submit-button').tap();
    await eventually(() => row('rice').locator('.item').textContent(), 'Brown rice × 250');
    assert.equal(await page.locator('#quantity').inputValue(), '1');
    assert.equal(await page.locator('#quantity option').count(), 100);

    // Realtime updates while editing preserve the draft, quantity and item identity.
    await row('apples').locator('.edit').tap();
    await page.locator('#name').fill('Green apples');
    rows.find(item => item.id === 'apples').purchased = true;
    await broadcast();
    await eventually(() => row('apples').locator('input').isChecked(), true);
    assert.equal(await page.locator('#name').inputValue(), 'Green apples');
    assert.equal(await page.locator('#quantity').inputValue(), '3');
    await page.locator('#submit-button').tap();
    await eventually(() => row('apples').locator('.item').textContent(), 'Green apples × 3');
    await row('milk').locator('.remove').tap();
    await eventually(() => row('milk').count(), 0);
    assert.ok(rows.some(item => item.id === 'apples'));

    // Autocomplete, multi-item quantities and drafts survive mode switches.
    const input = page.locator('#name');
    await input.fill('Eggs, 3 br');
    await page.locator('#suggestions li').filter({ hasText: 'Brown rice' }).tap();
    assert.equal(await input.inputValue(), 'Eggs, 3 Brown rice');
    await page.selectOption('#quantity', '4');
    await page.locator('#list-mode').tap();
    assert.equal(await input.inputValue(), 'Eggs, 3 Brown rice');
    assert.equal(await page.locator('#quantity').inputValue(), '4');
    await page.locator('#shopping-mode').tap();
    await page.locator('#submit-button').tap();
    await eventually(() => page.locator('#list > li').count(), 5);
    const inserted = calls.find(call => call.operation === 'insert').payload;
    assert.deepEqual(inserted.map(item => [item.item_name, item.quantity]), [['Eggs', 4], ['Brown rice', 3]]);
    assert.equal(await page.locator('#quantity').inputValue(), '1');

    // Reconnect reloads, remote insert/edit/delete, and autocomplete refresh.
    rows.push({ id: 'remote', item_name: 'Broccoli', quantity: 5, purchased: false, list_id: listId });
    await page.evaluate(() => window.realtimeStatus('SUBSCRIBED'));
    await eventually(() => row('remote').count(), 1);
    await input.fill('bro');
    await eventually(() => page.locator('#suggestions').textContent(), 'BroccoliBrown rice');
    rows.find(item => item.id === 'remote').item_name = 'Broccolini';
    await broadcast();
    await eventually(() => row('remote').locator('.item').textContent(), 'Broccolini × 5');
    await row('remote').locator('.edit').tap();
    rows = rows.filter(item => item.id !== 'remote');
    await broadcast();
    await eventually(() => row('remote').count(), 0);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('#submit-button').textContent(), 'Add to list');

    // Invitation create and redeem still work through their original flow.
    await page.locator('#create-invite').tap();
    await page.locator('#invite-link-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#invite-link').inputValue(), `http://grocery.test/#invite=${inviteToken}`);
    const invited = await openPage(`#invite=${inviteToken}`);
    await invited.locator('#join-list').tap();
    await invited.locator('#grocery-content').waitFor({ state: 'visible' });
    assert.equal(new URL(invited.url()).hash, '');
    assert.ok(calls.some(call => call.rpc === 'redeem_grocery_list_invite'));

    // Complete, clear, empty, then a new item; no stale progress or division by zero.
    rows.forEach(item => { item.purchased = true; });
    await broadcast();
    await eventually(progress, [rows.length, rows.length]);
    assert.equal(await page.locator('#status').textContent(), `0 of ${rows.length} items left to buy`);
    await page.locator('#clear').tap();
    await eventually(() => page.locator('#list > li').count(), 0);
    assert.deepEqual(await progress(), [0, 1]);
    assert.equal(await page.locator('#shopping-progress').getAttribute('aria-valuetext'), 'No items yet');
    assert.equal(await page.locator('#clear').isDisabled(), true);
    await input.fill('A very long grocery item name that wraps on a narrow mobile screen');
    await page.locator('#submit-button').tap();
    await eventually(() => page.locator('#list > li').count(), 1);
    assert.deepEqual(await progress(), [0, 1]);
    for (const mode of ['#list-mode', '#shopping-mode']) {
      await page.locator(mode).tap();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(blockedRequests, []);
    console.log(`PASS ${width}px touch viewport: modes, targets, sorting, focus, progress, failures, shared refresh, editing, quantities, autocomplete, multi-item entry, invitations, clear/empty, layout`);
  } finally { await context.close(); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    for (const width of [320, 390, 430]) await run(browser, width);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
