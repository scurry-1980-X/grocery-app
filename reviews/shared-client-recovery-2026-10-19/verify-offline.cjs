// New recovery verification, not a recovered historical test suite.
// In-memory DOM/storage/RPC substitutes only. No server, browser, network or SQL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const html = read('client/index.html');
const shared = read('client/shared.js');
const protocol = read('client/mutation-protocol.js');

function environment() {
  const storage = new Map();
  const listeners = new Map();
  const elements = new Map();
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    assert.ok(!elements.has(id), `duplicate HTML ID: ${id}`);
    elements.set(id, {
      addEventListener(event, callback) { listeners.set(`${id}:${event}`, callback); },
    });
  }
  const window = { addEventListener() {} };
  const context = vm.createContext({
    window, crypto: crypto.webcrypto,
    navigator: { onLine: true, locks: { request: async (_key, task) => task() } },
    document: {
      getElementById(id) { assert.ok(elements.has(id), `missing HTML ID: ${id}`); return elements.get(id); },
      addEventListener() {},
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  vm.runInContext(protocol, context, { timeout: 1000 });
  return { context, api: window.GroceryMutation, storage, listeners };
}

test('all shared-client IDs and script dependencies are present in order', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const [, id] of shared.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id), id);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['shared-config.js', 'mutation-protocol.js', 'shared.js']);
  for (const script of scripts) assert.ok(fs.existsSync(path.join(__dirname, 'client', script)));
  assert.ok(fs.existsSync(path.join(__dirname, 'client/vendor/supabase-2.118.0.js')));
});

test('recovered shared module initializes and registers every mutation UI handler', () => {
  const env = environment();
  vm.runInContext(shared, env.context, { timeout: 1000 });
  for (const name of ['cloud-form:submit', 'cloud-clear:click', 'cloud-import:click',
    'create-list:click', 'create-invite:click', 'join-form:submit', 'check-pending:click']) {
    assert.ok(env.listeners.has(name), name);
  }
});

test('actual recovered protocol routes persisted intents to 002/003 correctly', async () => {
  const { api } = environment();
  const user = crypto.randomUUID(), list = crypto.randomUUID(), revision = crypto.randomUUID();
  const cases = [
    ['create', null, {}], ['invite', list, {}],
    ['edit', list, { id: '-1', revision, item_name: 'Milk', quantity: 1, purchased: true }],
    ['delete', list, { id: '-1', revision }],
    ['clear_purchased', list, { targets: [{ id: '-1', revision }] }],
  ];
  for (const [operation, listId, payload] of cases) {
    const saved = api.prepare(user, listId, operation, payload);
    assert.throws(() => api.prepare(user, listId, operation, payload), /unconfirmed/);
    let call;
    const client = { rpc: async (name, args) => { call = { name, args }; return { data: 'mock' }; } };
    await api.execute(client, saved);
    const expected = operation === 'create'
      ? { name: 'create_grocery_list_once', args: { request_id: saved.requestId } }
      : { name: 'mutate_grocery_once', args: { request_id: saved.requestId,
        target_list_id: listId, operation, payload } };
    assert.deepEqual(JSON.parse(JSON.stringify(call)), expected);
    const result = { status: 'ok', token: crypto.randomUUID(), expires_at: 'test-expiry' };
    api.complete(saved, result);
    assert.equal(api.read(user).state, 'confirmed');
    if (operation === 'invite') assert.equal(api.read(user).result.token, undefined);
  }
});

test('client and runner share exact protocol and SDK bytes; configuration is inert', () => {
  assert.equal(read('runner/mutation-protocol.js'), protocol);
  assert.equal(read('runner/supabase.js'), read('client/vendor/supabase-2.118.0.js'));
  assert.deepEqual(JSON.parse(read('runner/public-config.json')), { url: '', publishableKey: '' });
  const context = vm.createContext({ window: {} });
  vm.runInContext(read('client/shared-config.js'), context);
  assert.equal(context.window.GROCERY_SHARED_CONFIG.url, '');
  assert.equal(context.window.GROCERY_SHARED_CONFIG.publishableKey, '');
  const helper = read('runner/grocery-live-validation.py');
  const runner = read('runner/runner.js');
  assert.match(helper, /PROJECT = 'https:\/\/grocery-review\.invalid'/);
  assert.match(helper, /EXPECTED_EMAIL = 'account-1@example\.invalid'/);
  assert.match(runner, /const expected = \['account-1@example\.invalid', 'account-2@example\.invalid'\]/);
  for (const source of [helper, runner]) {
    assert.doesNotMatch(source, /https?:\/\/[a-z0-9-]+\.supabase\.co/i);
    const emails = source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    assert.ok(emails.every(email => /^account-[12]@example\.invalid$/.test(email)));
  }
});

test('runner serves the recovered protocol and uses protected edit/create/invite calls', () => {
  const runner = read('runner/runner.js');
  const helper = read('runner/grocery-live-validation.py');
  assert.match(helper, /src="\/mutation-protocol\.js"/);
  assert.match(helper, /'\/mutation-protocol\.js'\)/);
  assert.match(runner, /protectedMutation\('create', \{\}\)/);
  assert.match(runner, /protectedMutation\('invite', \{\}\)/);
  assert.match(runner, /protectedMutation\('edit',/);
  assert.doesNotMatch(runner, /\.update\(|rpc\('create_grocery_list'\)|rpc\('create_grocery_list_invite'/);
});
