// Uses an existing Playwright installation; no application dependencies required.
// PLAYWRIGHT_PATH=/path/to/playwright-core node tests/autocomplete.cjs
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const html = fs.readFileSync('index.html', 'utf8');
    const mock = `
      const calls = window.calls = [];
      let rows = [
        { id: '1', item_name: 'Milk', quantity: 2, purchased: false },
        { id: '2', item_name: 'MILK', quantity: 1, purchased: true },
        { id: '3', item_name: 'Almond milk', quantity: 1, purchased: false }
      ];
      const createClient = () => ({
        auth: { getSession: async () => ({ data: { session: { user: { id: 'user' } } } }) },
        rpc: async name => { calls.push(name); return { data: '11111111-1111-1111-1111-111111111111' }; },
        from: () => {
          let operation = 'select', payload;
          const query = {
            select: () => query, eq: () => query,
            insert: value => { operation = 'insert'; payload = value; return query; },
            update: value => { operation = 'update'; payload = value; return query; },
            then: resolve => {
              calls.push({ operation, payload });
              if (operation === 'insert') rows.push(...payload.map((item, i) => ({ ...item, id: String(rows.length + i + 1) })));
              resolve({ data: operation === 'insert' ? rows.slice(-payload.length) : rows });
            }
          }; return query;
        },
        channel: () => ({ on: (type, filter, callback) => {
          window.refreshRows = value => { rows = value; callback(); };
          return { subscribe: callback => callback('SUBSCRIBED') };
        } })
      });`;
    await page.route('http://grocery.test/', route => route.fulfill({ contentType: 'text/html', body: html.replace('const { createClient } = await import(supabaseModuleUrl);', mock) }));
    await page.goto('http://grocery.test/');
    await page.locator('#grocery-content').waitFor({ state: 'visible' });
    const input = page.locator('#name');
    await input.fill('mI');
    assert.equal(await page.locator('#suggestions li').count(), 2);
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    await input.press('ArrowDown');
    await input.press('Enter');
    assert.equal((await input.inputValue()).toLowerCase(), 'milk');
    assert.equal(await page.locator('#list > li').count(), 3); // selection never submits
    await input.fill('Bread, 3 al');
    await page.locator('#suggestions li').tap();
    assert.equal(await input.inputValue(), 'Bread, 3 Almond milk');
    await page.selectOption('#quantity', '4');
    await page.locator('#submit-button').click();
    await page.waitForFunction(() => window.calls.some(call => call.operation === 'insert'));
    const insert = await page.evaluate(() => window.calls.find(call => call.operation === 'insert').payload);
    assert.deepEqual(insert.map(item => [item.item_name, item.quantity]), [['Bread', 4], ['Almond milk', 3]]);
    assert.equal(await page.locator('#quantity option').count(), 100);
    await input.fill('Milk, mi');
    assert.deepEqual(await page.locator('#suggestions li').allTextContents(), ['Almond milk']);
    await input.press('Escape');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await input.fill('mi');
    await page.evaluate(() => window.refreshRows([{ id: 'new', item_name: 'Millet', quantity: 7, purchased: false }]));
    await page.waitForFunction(() => document.querySelector('#suggestions').textContent === 'Millet');
    await page.locator('.edit').click();
    assert.equal(await input.inputValue(), 'Millet');
    assert.equal(await page.locator('#quantity').inputValue(), '7');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await page.locator('#cancel-edit').click();
    await page.locator('#create-invite').click();
    await page.locator('#invite-link-panel').waitFor({ state: 'visible' });
    assert.match(await page.locator('#invite-link').inputValue(), /#invite=/);
    await input.fill('zzzz');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await input.fill('mi');
    const dimensions = await page.locator('#suggestions li').boundingBox();
    assert.ok(dimensions.height >= 48);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await input.fill('');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => window.refreshRows(Array.from({ length: 9 }, (_, i) => ({
      id: String(i), item_name: i === 0 ? 'Whole milk' : `Milk ${i}`, quantity: 1, purchased: false
    }))));
    await page.waitForFunction(() => document.querySelectorAll('#list > li').length === 9);
    await input.fill('milk');
    assert.equal(await page.locator('#suggestions li').count(), 6);
    assert.equal(await page.locator('#suggestions li').first().textContent(), 'Milk 1');
    await input.press('ArrowUp');
    assert.equal(await input.getAttribute('aria-activedescendant'), 'grocery-suggestion-5');
    await page.locator('#quantity').focus();
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
    console.log('PASS: mobile autocomplete, deduplication, keyboard/touch, multi-item quantities, Realtime refresh, edit, invitations, and layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
