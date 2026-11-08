// Existing Playwright + Chromium/Chrome only; all network access is intercepted.
// PLAYWRIGHT_PATH=/path/to/playwright-core BROWSER_PATH=/path/to/chrome node tests/reliability.cjs
// APP_HTML optionally points to a baseline HTML file to reproduce regressions.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const { setTimeout: delay } = require('node:timers/promises');
const html = fs.readFileSync(process.env.APP_HTML || path.join(__dirname, '../index.html'), 'utf8');
const listId = '11111111-1111-1111-1111-111111111111';
const seed = () => ['Apples', 'Bread', 'Milk'].map((item_name, i) => ({
  id: String(i + 1), item_name, quantity: i + 1, purchased: false, list_id: listId
}));
const sdk = `
export const createClient = () => ({
  auth: { getSession: async () => ({ data: { session: { user: { id: 'test-user' } } } }) },
  rpc: async () => ({ data: '${listId}' }),
  from: table => {
    const request = { table, operation: 'select', filters: [] };
    const query = {
      select: columns => { request.columns = columns; return query; },
      eq: (key, value) => { request.filters.push([key, value]); return query; },
      in: (key, values) => { request.filters.push([key, values]); return query; },
      insert: payload => { Object.assign(request, { operation: 'insert', payload }); return query; },
      update: payload => { Object.assign(request, { operation: 'update', payload }); return query; },
      delete: () => { request.operation = 'delete'; return query; },
      then: (resolve, reject) => window.mockQuery(request).then(resolve, reject)
    };
    return query;
  },
  channel: () => ({ on: (type, filter, callback) => {
    window.realtimeEvent = callback;
    return { subscribe: status => status('SUBSCRIBED') };
  } })
});`;
async function eventually(read, expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (JSON.stringify(await read()) === JSON.stringify(expected)) return;
    await delay(20);
  }
  assert.deepEqual(await read(), expected);
}
async function fixture(browser, width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  const state = { rows: seed(), calls: [], errors: [], readFailure: null, next: null, holds: [], blocked: [], ...options };
  let nextId = 100;
  await context.exposeFunction('mockQuery', async request => {
    assert.equal(request.table, 'grocery_items');
    state.calls.push(request);
    let behavior = request.operation === 'select' ? state.readFailure : null;
    if (state.next?.operation === request.operation) {
      behavior = state.next.behavior;
      state.next = null;
    }
    const gate = state.holds.find(gate => !gate.used && gate.operation === request.operation);
    if (gate) { gate.used = true; await gate.promise; }
    if (behavior === 'throw') throw new Error('Simulated transport failure');
    if (behavior === 'error') return { data: null, error: { message: 'Simulated denial' } };
    if (behavior === 'zero') return { data: [], error: null };
    if (behavior === 'null') return { data: null, error: null };
    const matches = row => request.filters.every(([key, value]) =>
      Array.isArray(value) ? value.includes(row[key]) : row[key] === value);
    let data = [];
    if (request.operation === 'insert') {
      data = request.payload.map(row => ({ ...row, id: String(++nextId) }));
      state.rows.push(...data);
    } else if (request.operation === 'update') {
      data = state.rows.filter(matches);
      data.forEach(row => Object.assign(row, request.payload));
    } else if (request.operation === 'delete') {
      data = state.rows.filter(matches);
      if (behavior === 'partial') data = data.slice(0, 1);
      const ids = new Set(data.map(row => row.id));
      state.rows = state.rows.filter(row => !ids.has(row.id));
    } else data = state.rows.filter(matches);
    if (behavior === 'lost') throw new Error('Committed, but acknowledgement lost');
    // PostgREST returns mutation rows only when representation is requested.
    return { data: request.columns ? structuredClone(data) : null, error: null };
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://grocery.test' && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.hostname === 'esm.sh') return route.fulfill({ contentType: 'text/javascript', body: sdk });
    if (url.origin !== 'http://grocery.test') state.blocked.push(url.href);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  page.on('pageerror', error => state.errors.push(error.message));
  await page.goto('http://grocery.test/');
  await page.locator('#grocery-content').waitFor({ state: 'visible' });
  if (state.readFailure) await eventually(() => page.locator('#load-error').textContent(),
    'Could not load your groceries. Your list may not be empty. Retry loading the list.');
  else await eventually(() => page.locator('#list > li').count(), state.rows.length);
  // Settle the initial subscription read so it cannot consume a later test failure.
  await delay(120);
  return {
    page, state, input: page.locator('#name'), quantity: page.locator('#quantity'),
    row: id => page.locator(`#list > li[data-item-id="${id}"]`),
    texts: () => page.locator('#list .item').allTextContents(),
    hold(operation) {
      let release;
      const gate = { operation, used: false, promise: new Promise(resolve => { release = resolve; }) };
      state.holds.push(gate);
      return { release, started: () => eventually(() => gate.used, true) };
    },
    submit: () => page.locator('#submit-button').tap(),
    refresh: () => page.evaluate(() => window.realtimeEvent()),
    close: async () => {
      const errors = [...state.errors], blocked = [...state.blocked];
      await context.close();
      assert.deepEqual(errors, [], 'No uncaught browser errors');
      assert.deepEqual(blocked, [], 'No external requests');
    }
  };
}
const cases = [];
const check = (name, run, options) => cases.push({ name, run, options });

check('pending edit can be cancelled safely', async f => {
  const gate = f.hold('update');
  await f.row('1').locator('.edit').tap();
  await f.input.fill('Renamed apples'); await f.submit(); await gate.started();
  await f.page.locator('#cancel-edit').tap();
  await f.input.fill('New draft after cancel'); gate.release();
  await eventually(() => f.row('1').locator('.item').textContent(), 'Renamed apples × 1');
  assert.equal(await f.input.inputValue(), 'New draft after cancel');
  assert.deepEqual(f.state.errors, []);
});

check('pending edit cannot overwrite another item or its draft', async f => {
  const gate = f.hold('update');
  await f.row('1').locator('.edit').tap();
  await f.input.fill('Renamed apples'); await f.submit(); await gate.started();
  await f.row('2').locator('.edit').tap();
  await f.input.fill('Bread draft'); await f.quantity.selectOption('9');
  f.state.readFailure = 'error'; gate.release();
  await eventually(() => f.row('1').locator('.item').textContent(), 'Renamed apples × 1');
  assert.equal(await f.row('2').locator('.item').textContent(), 'Bread × 2');
  assert.equal(await f.input.inputValue(), 'Bread draft');
  assert.equal(await f.quantity.inputValue(), '9');
});

check('double submit sends exactly one insert and preserves a newer draft', async f => {
  const gate = f.hold('insert');
  await f.input.fill('Eggs'); await f.submit(); await gate.started();
  // Bypass the disabled button to verify the handler also rejects overlapping events.
  await f.page.locator('#form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await f.input.fill('Next unsaved item'); await f.quantity.selectOption('7');
  gate.release();
  await eventually(() => f.page.locator('#list > li').count(), 4);
  assert.equal(f.state.calls.filter(call => call.operation === 'insert').length, 1);
  assert.equal(f.state.rows.filter(row => row.item_name === 'Eggs').length, 1);
  assert.equal(await f.input.inputValue(), 'Next unsaved item');
  assert.equal(await f.quantity.inputValue(), '7');
});

check('failed saves with long names fit a narrow mobile screen', async f => {
  await f.input.fill('X'.repeat(150));
  f.state.next = { operation: 'insert', behavior: 'error' };
  await f.submit();
  await eventually(() => f.page.locator('#form-error').textContent(),
    `Could not confirm saving ${'X'.repeat(150)}. Check the refreshed list before trying again. Any current draft has been kept.`);
  assert.equal(await f.input.inputValue(), 'X'.repeat(150));
});

check('autocomplete selection during a pending add is preserved', async f => {
  const gate = f.hold('insert');
  await f.input.fill('Eggs'); await f.submit(); await gate.started();
  await f.input.fill('br'); await f.page.locator('#suggestions li').tap();
  gate.release();
  await eventually(() => f.page.locator('#list > li').count(), 4);
  assert.equal(await f.input.inputValue(), 'Bread');
});

for (const reverse of [false, true]) check(`concurrent removals reconcile IDs (${reverse ? 'reverse' : 'forward'} responses)`, async f => {
  const first = f.hold('delete'), second = f.hold('delete');
  await f.row('1').locator('.remove').tap(); await first.started();
  await f.row('2').locator('.remove').tap(); await second.started();
  f.state.readFailure = 'error';
  const gates = reverse ? [second, first] : [first, second];
  gates[0].release();
  await eventually(() => f.page.locator('#list > li').count(), 2);
  gates[1].release();
  await eventually(f.texts, ['Milk × 3']);
  assert.deepEqual(f.state.rows.map(row => row.id), ['3']);
});

for (const failure of ['error', 'throw']) check(`initial ${failure} read shows retry instead of empty list`, async f => {
  assert.doesNotMatch(await f.page.locator('#status').textContent(), /empty/);
  assert.equal(await f.page.locator('#load-error').getAttribute('role'), 'alert');
  assert.equal(await f.page.locator('#shopping-progress').isVisible(), false);
  assert.equal(await f.page.locator('#submit-button').isDisabled(), true);
  await f.input.fill('Kept while reconnecting');
  f.state.readFailure = null;
  await f.page.locator('#retry-list').tap();
  await eventually(() => f.page.locator('#list > li').count(), 3);
  assert.equal(await f.input.inputValue(), 'Kept while reconnecting');
  assert.equal(await f.page.locator('#submit-button').isEnabled(), true);
  assert.equal(await f.page.locator('#load-error').textContent(), '');
  assert.equal(await f.input.evaluate(node => node === document.activeElement), true);
}, { readFailure: failure });

check('failed refresh retains the last list and draft, and retry recovers', async f => {
  await f.row('2').locator('.edit').tap(); await f.input.fill('Bread draft');
  f.state.readFailure = 'throw'; await f.refresh();
  await eventually(() => f.page.locator('#status').textContent(), 'List may be out of date.');
  assert.deepEqual(await f.texts(), ['Apples × 1', 'Bread × 2', 'Milk × 3']);
  assert.equal(await f.input.inputValue(), 'Bread draft');
  assert.equal(await f.row('1').locator('input').isDisabled(), true);
  f.state.readFailure = null; await f.page.locator('#retry-list').tap();
  await eventually(() => f.page.locator('#submit-button').isEnabled(), true);
  assert.equal(await f.input.inputValue(), 'Bread draft');
});

for (const failure of ['error', 'throw', 'zero', 'null']) check(`unacknowledged edit (${failure}) preserves draft and supports explicit retry`, async f => {
  await f.row('1').locator('.edit').tap(); await f.input.fill('Changed apples');
  f.state.next = { operation: 'update', behavior: failure };
  await f.submit();
  await eventually(() => f.page.locator('#form-error').textContent(),
    'Could not confirm saving Changed apples. Check the refreshed list before trying again. Any current draft has been kept.');
  assert.equal(await f.input.inputValue(), 'Changed apples');
  assert.equal(await f.row('1').locator('.item').textContent(), 'Apples × 1');
  assert.equal(await f.page.locator('#form-error').getAttribute('role'), 'alert');
  assert.equal(f.state.calls.filter(call => call.operation === 'update').length, 1);
  await f.submit();
  await eventually(() => f.row('1').locator('.item').textContent(), 'Changed apples × 1');
  assert.equal(await f.input.inputValue(), '');
});

check('a lost insert acknowledgement never triggers an automatic write retry', async f => {
  await f.input.fill('Eggs');
  f.state.next = { operation: 'insert', behavior: 'lost' };
  await f.submit();
  await eventually(() => f.page.locator('#list > li').count(), 4);
  assert.equal(await f.input.inputValue(), 'Eggs');
  assert.match(await f.page.locator('#form-error').textContent(), /Check the refreshed list/);
  assert.equal(f.state.calls.filter(call => call.operation === 'insert').length, 1);
  assert.equal(f.state.rows.filter(row => row.item_name === 'Eggs').length, 1);
});

for (const failure of ['error', 'throw', 'zero', 'null']) check(`unacknowledged insert (${failure}) keeps a multi-item draft`, async f => {
  await f.input.fill('Eggs, 3 Flour'); await f.quantity.selectOption('5');
  f.state.next = { operation: 'insert', behavior: failure };
  await f.submit();
  await eventually(() => f.page.locator('#form-error').textContent(),
    'Could not confirm saving Eggs, 3 Flour. Check the refreshed list before trying again. Any current draft has been kept.');
  assert.equal(await f.input.inputValue(), 'Eggs, 3 Flour');
  assert.equal(await f.quantity.inputValue(), '5');
  assert.equal(await f.page.locator('#list > li').count(), 3);
  await f.submit();
  await eventually(() => f.page.locator('#list > li').count(), 5);
  assert.deepEqual(f.state.rows.slice(-2).map(row => [row.item_name, row.quantity]), [['Eggs', 5], ['Flour', 3]]);
});

for (const failure of ['error', 'throw', 'zero']) check(`unacknowledged remove (${failure}) keeps its row`, async f => {
  f.state.next = { operation: 'delete', behavior: failure };
  await f.row('1').locator('.remove').tap();
  await eventually(() => f.page.locator('#write-error').textContent(),
    'Could not confirm removal of Apples. Check the refreshed list before trying again.');
  assert.equal(await f.row('1').count(), 1);
  assert.equal(await f.row('1').locator('.remove').isEnabled(), true);
  await f.row('1').locator('.remove').tap();
  await eventually(() => f.row('1').count(), 0);
});

check('zero-row purchase is rolled back with an accessible error', async f => {
  f.state.next = { operation: 'update', behavior: 'zero' };
  await f.row('1').locator('input').tap();
  await eventually(() => f.page.locator('#purchase-error').textContent(),
    'Could not confirm purchase status. Check the refreshed list before trying again.');
  assert.equal(await f.row('1').locator('input').isChecked(), false);
  assert.equal(await f.page.locator('#shopping-progress').evaluate(node => node.value), 0);
});

for (const failure of ['zero', 'partial', 'throw']) check(`clear purchased (${failure}) reconciles only acknowledged IDs and keeps drafts`, async f => {
  f.state.rows[0].purchased = true; f.state.rows[1].purchased = true;
  await f.refresh(); await eventually(() => f.page.locator('#shopping-progress').evaluate(node => node.value), 2);
  await f.input.fill('Do not erase this draft');
  f.state.next = { operation: 'delete', behavior: failure };
  await f.page.locator('#clear').tap();
  await eventually(() => f.page.locator('#write-error').textContent(), failure === 'partial' ?
    'Some items were not removed. Refresh the list before trying again.' :
    'Could not confirm clearing purchased items. Check the refreshed list before trying again.');
  assert.equal(await f.input.inputValue(), 'Do not erase this draft');
  assert.equal(await f.page.locator('#list > li').count(), failure === 'partial' ? 2 : 3);
  assert.equal(await f.row('3').count(), 1);
  await f.page.locator('#clear').tap(); await eventually(f.texts, ['Milk × 3']);
  assert.equal(await f.input.inputValue(), 'Do not erase this draft');
});

check('remote deletion preserves an edit draft rather than converting it into a new insert', async f => {
  await f.row('1').locator('.edit').tap(); await f.input.fill('Unsaved apples');
  f.state.rows = f.state.rows.filter(row => row.id !== '1'); await f.refresh();
  await eventually(() => f.row('1').count(), 0);
  assert.equal(await f.input.inputValue(), 'Unsaved apples');
  assert.match(await f.page.locator('#form-error').textContent(), /no longer available/);
  await f.submit();
  assert.equal(f.state.calls.filter(call => call.operation !== 'select').length, 0);
});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  let failures = 0, passed = 0;
  try {
    const widths = (process.env.TEST_WIDTHS || '320,390').split(',').map(Number);
    for (const width of widths) for (const scenario of cases) {
      if (process.env.CASE_PATTERN && !new RegExp(process.env.CASE_PATTERN).test(scenario.name)) continue;
      let f;
      try {
        f = await fixture(browser, width, scenario.options);
        await scenario.run(f);
        assert.deepEqual(f.state.errors, []);
        assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        console.log(`PASS ${width}px: ${scenario.name}`); passed++;
      } catch (error) {
        failures++; console.error(`FAIL ${width}px: ${scenario.name}\n${error.stack}`);
      } finally {
        if (f) {
          try { await f.close(); } catch (error) { failures++; console.error(error.message); }
        }
      }
    }
  } finally { await browser.close(); }
  console.log(`${passed} scenarios passed; ${failures} failures`);
  if (failures) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
