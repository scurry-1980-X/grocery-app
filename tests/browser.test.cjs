const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

// No app server or production service is required. Serve only the two assets.
test('grocery workflow, validation, persistence and storage failures', async t => {
  const server = http.createServer(async (req, res) => {
    const file = { '/': 'index.html', '/grocery_app_icon.png': 'grocery_app_icon.png' }[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    try {
      const data = await fs.readFile(path.join(__dirname, '..', file));
      res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8' }).end(data);
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox'],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await page.goto(url)).status(), 200);
  assert.equal(await page.title(), 'My Grocery List');
  assert.equal((await page.request.get(`${url}/grocery_app_icon.png`)).status(), 200);
  const names = () => page.locator('.item').allTextContents();
  const submit = async (name, quantity = '1') => {
    await page.locator('#name').fill(name);
    await page.locator('#quantity').fill(quantity);
    await page.locator('#submit-button').click();
  };
  assert.equal(await page.locator('#clear').isDisabled(), true);
  await submit('2 apples, milk', '3');
  assert.deepEqual(await names(), ['apples × 2', 'milk × 3']);
  await page.reload();
  assert.deepEqual(await names(), ['apples × 2', 'milk × 3']);
  for (const entry of ['bread, 0 pears', '1000 beans', '1.5 apples', '-2 apples', ', ,']) {
    await submit(entry);
    assert.deepEqual(await names(), ['apples × 2', 'milk × 3']);
    assert.equal(await page.locator('#name').inputValue(), entry);
    assert.ok(await page.locator('#name').evaluate(el => el.validationMessage));
  }
  // Switching from a rejected add to an edit clears stale form validity.
  await page.getByRole('button', { name: 'Edit apples', exact: true }).click();
  await page.locator('#submit-button').click();
  assert.equal(await page.locator('#submit-button').innerText(), 'Add to list');
  await submit('7up, 123');
  assert.deepEqual(await names(), ['apples × 2', 'milk × 3', '7up × 1', '123 × 1']);
  await page.getByRole('button', { name: 'Edit apples', exact: true }).click();
  await page.locator('#name').fill('Discard me');
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  assert.equal((await names())[0], 'apples × 2');
  await page.getByRole('button', { name: 'Edit apples', exact: true }).click();
  await submit('Pears', '4');
  assert.equal((await names())[0], 'Pears × 4');
  await page.getByRole('checkbox', { name: 'Purchased Pears', exact: true }).check();
  assert.equal(await page.locator('#status').innerText(), '3 of 4 items left to buy');
  await page.reload();
  assert.equal(await page.getByRole('checkbox', { name: 'Purchased Pears', exact: true }).isChecked(), true);
  await page.getByRole('checkbox', { name: 'Purchased Pears', exact: true }).uncheck();
  assert.equal(await page.locator('#clear').isDisabled(), true);
  await page.getByRole('checkbox', { name: 'Purchased Pears', exact: true }).check();
  await page.locator('#clear').click();
  assert.deepEqual(await names(), ['milk × 3', '7up × 1', '123 × 1']);
  // Removing an earlier row must preserve the target of an ongoing edit.
  await page.getByRole('button', { name: 'Edit 123', exact: true }).click();
  await page.getByRole('button', { name: 'Remove milk', exact: true }).click();
  await submit('Numbers', '2');
  assert.deepEqual(await names(), ['7up × 1', 'Numbers × 2']);
  await page.getByRole('button', { name: 'Edit Numbers', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Numbers', exact: true }).click();
  assert.equal(await page.locator('#submit-button').innerText(), 'Add to list');
  await page.getByRole('button', { name: 'Remove 7up', exact: true }).click();
  await page.reload();
  assert.deepEqual(await names(), []);
  assert.match(await page.locator('#status').innerText(), /Your list is empty/);
  // Invalid form quantities must not save anything.
  for (const quantity of ['0', '1000', '1.5']) {
    await submit('milk', quantity);
    assert.deepEqual(await names(), []);
  }
  await page.evaluate(() => localStorage.setItem('my-groceries-v1', JSON.stringify([
    { name: 'Valid', quantity: 2, done: false },
    { name: 'Invalid', quantity: 0, done: false },
  ])));
  await page.reload();
  assert.deepEqual(await names(), ['Valid × 2']);
  await page.evaluate(() => localStorage.setItem('my-groceries-v1', '{bad json'));
  await page.reload();
  assert.match(await page.locator('#status').innerText(), /Browser storage unavailable/);
  await submit('Recovered');
  await page.reload();
  assert.deepEqual(await names(), ['Recovered × 1']);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage blocked'); }; });
  await submit('Temporary');
  assert.deepEqual(await names(), ['Recovered × 1', 'Temporary × 1']);
  assert.match(await page.locator('#status').innerText(), /Browser storage unavailable/);
  assert.deepEqual(errors, []);
});
