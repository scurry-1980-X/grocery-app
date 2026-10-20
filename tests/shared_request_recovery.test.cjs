const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.join(__dirname, '../reviews/shared-client-recovery-2026-10-19/client');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const userId = crypto.randomUUID(), listId = crypto.randomUUID();
const payload = { id: '-1', revision: crypto.randomUUID(), item_name: 'Milk', quantity: 1, purchased: false };
const plain = value => JSON.parse(JSON.stringify(value));
const rejection = (code, message, status = 400) => ({
  data: null, error: { code, message, details: null, hint: null }, status,
});

// Execute the actual shared client and protocol. A test-only closure seam exposes
// protectedRequest and controls without changing their implementation or shipping
// a runtime API. DOM, RPC, and Web Locks are in-memory; no backend is contacted.
function environment(rpc, storage = new Map()) {
  const elements = new Map();
  const element = () => ({
    value: '', addEventListener() {}, replaceChildren() {}, setCustomValidity() {},
    querySelectorAll() { return []; }, querySelector() { return this; },
  });
  for (const [, id] of read('index.html').matchAll(/\bid="([^"]+)"/g)) elements.set(id, element());
  const client = {
    rpc,
    from() {
      const query = {
        select() { return this; }, eq() { return this; }, order() { return this; },
        range: async () => ({ data: [], error: null }),
      };
      return query;
    },
  };
  const window = { addEventListener() {} };
  const localStorage = {
    get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null,
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const context = vm.createContext({
    window, crypto: crypto.webcrypto, localStorage, clearInterval() {},
    navigator: { onLine: true, locks: { request: async (_key, task) => task() } },
    document: { getElementById: id => elements.get(id), createElement: element, addEventListener() {} },
    testClient: client, testUser: { id: userId }, testList: listId,
  });
  vm.runInContext(read('mutation-protocol.js'), context);
  const shared = read('shared.js');
  assert.ok(shared.endsWith('})();\n'));
  vm.runInContext(shared.slice(0, -6) + `
    client = testClient; user = testUser; listId = testList;
    active = true; loaded = true;
    window.test = { protectedRequest, controls, resetCloud };
  })();`, context);
  return {
    request: window.test.protectedRequest, reset: window.test.resetCloud,
    receipt: () => plain(window.GroceryMutation.read(userId)),
    blocked() { window.test.controls(); return elements.get('cloud-submit').disabled; },
    elements, storage, localStorage,
  };
}

for (const [code, message, status] of [
  ['P0001', 'Invalid item values', 400],
  ['P0001', 'You are not a member of this grocery list', 400],
  ['P0001', 'Access to the previously created list is no longer available', 400],
  ['23514', 'check constraint failed', 400],
  ['23505', 'unique constraint failed', 409],
  ['22P02', 'invalid input syntax', 400],
  ['42501', 'permission denied', 403],
]) {
  test(`confirmed rejection releases pending gate: ${code} / ${message}`, async () => {
    const calls = [];
    const error = rejection(code, message, status);
    const env = environment(async (_name, args) => {
      calls.push(plain(args));
      return calls.length === 1 ? error : { data: { status: 'ok' }, error: null, status: 200 };
    });
    await assert.rejects(env.request('edit', payload), e => e === error.error);
    const rejected = env.receipt();
    assert.equal(rejected.state, 'confirmed');
    assert.equal(rejected.result.status, 'rejected');
    assert.equal(env.blocked(), false);
    await env.request('edit', { ...payload, item_name: 'Bread' });
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].request_id, calls[0].request_id);
    assert.equal(env.receipt().result.status, 'ok');
  });
}

const uncertain = [
  ['thrown network failure', () => { throw new TypeError('Failed to fetch'); }],
  ['thrown timeout', () => { throw new Error('Request timed out'); }],
  ['SDK transport failure', () => rejection('', 'TypeError: Failed to fetch', 0)],
  ['gateway failure', () => rejection('', 'Bad Gateway', 502)],
  ['HTTP timeout', () => rejection('P0001', 'Invalid item values', 408)],
  ['rate limit', () => rejection('P0001', 'Invalid item values', 429)],
  ['missing HTTP status', () => ({ error: { code: 'P0001', message: 'Invalid item values' } })],
  ['unknown SQL exception', () => rejection('P0001', 'Unknown server error')],
  ['unavailable mutation result', () => rejection('P0001', 'Result unavailable; retry the same request')],
  ['unavailable create result', () => rejection('P0001', 'Creation result unavailable; retry with the same request ID')],
  ['incomplete ledger result', () => rejection('P0001', 'Incomplete mutation result')],
  ['request ID reuse', () => rejection('P0001', 'Request ID already used with a different operation or payload')],
  ['connection SQLSTATE', () => rejection('08006', 'connection failure', 503)],
  ['serialization failure', () => rejection('40001', 'serialization failure', 500)],
  ['malformed success', () => ({ data: {}, error: null, status: 200 })],
];
for (const [label, fail] of uncertain) {
  test(`${label} retains the exact receipt and blocks new requests`, async () => {
    const calls = [];
    const env = environment(async (_name, args) => { calls.push(plain(args)); return fail(); });
    await assert.rejects(env.request('edit', payload));
    const saved = env.receipt();
    assert.equal(saved.state, 'pending');
    assert.deepEqual(saved.payload, payload);
    assert.equal(env.blocked(), true);
    await assert.rejects(env.request('delete', { id: '-1', revision: payload.revision }), /unconfirmed/);
    assert.equal(calls.length, 1);
    await assert.rejects(env.request(null, null, true));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.deepEqual(env.receipt(), saved);
  });
}

test('lost committed response replays after reload with one effect and the original request ID', async () => {
  const ledger = new Map(), calls = [];
  let effects = 0;
  const rpc = async (_name, args) => {
    calls.push(plain(args));
    if (ledger.has(args.request_id)) return { data: ledger.get(args.request_id), error: null };
    effects++;
    ledger.set(args.request_id, { status: 'ok', revision: crypto.randomUUID() });
    throw new TypeError('Response lost after commit');
  };
  const first = environment(rpc);
  await assert.rejects(first.request('edit', payload), /saved request ID/);
  const saved = first.receipt();
  const reloaded = environment(rpc, first.storage);
  const replay = await reloaded.request(null, null, true);
  assert.equal(effects, 1);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(replay.saved.requestId, saved.requestId);
  assert.deepEqual(reloaded.receipt().result, ledger.get(saved.requestId));
  assert.equal(reloaded.receipt().state, 'confirmed');
  assert.equal(reloaded.blocked(), false);
});

test('uncertain request that later receives a definite rejection can recover', async () => {
  const calls = [];
  const env = environment(async (_name, args) => {
    calls.push(plain(args));
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    if (calls.length === 2) return rejection('P0001', 'Invalid item values');
    return { data: { status: 'ok' }, error: null };
  });
  await assert.rejects(env.request('edit', payload));
  await assert.rejects(env.request(null, null, true), { message: 'Invalid item values' });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(env.blocked(), false);
  await env.request('edit', { ...payload, item_name: 'Bread' });
  assert.notEqual(calls[2].request_id, calls[0].request_id);
});

test('replayed conflict is confirmed, preserves input and permits a later mutation', async () => {
  const calls = [];
  const env = environment(async (_name, args) => {
    calls.push(plain(args));
    if (calls.length === 1) throw new TypeError('Response lost');
    return { data: { status: calls.length === 2 ? 'conflict' : 'ok' }, error: null };
  });
  env.elements.get('cloud-name').value = 'Unsaved edit';
  await assert.rejects(env.request('edit', payload));
  await assert.rejects(env.request(null, null, true), /changed or was removed/);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(env.receipt().state, 'confirmed');
  assert.equal(env.receipt().result.status, 'conflict');
  assert.equal(env.elements.get('cloud-name').value, 'Unsaved edit');
  assert.equal(env.blocked(), false);
  await env.request('delete', { id: '-1', revision: crypto.randomUUID() });
  assert.notEqual(calls[2].request_id, calls[0].request_id);
});

test('failure to persist rejection keeps the original pending request', async () => {
  const env = environment(async () => {
    env.localStorage.setItem = () => { throw new Error('Storage blocked'); };
    return rejection('P0001', 'Invalid item values');
  });
  await assert.rejects(env.request('edit', payload), /Storage blocked.*saved request ID/);
  assert.equal(env.receipt().state, 'pending');
  assert.equal(env.blocked(), true);
});

test('account change during RPC does not resolve a pending request', async () => {
  const env = environment(async () => {
    env.reset();
    return rejection('P0001', 'Invalid item values');
  });
  await assert.rejects(env.request('edit', payload), /account or list changed/);
  assert.equal(env.receipt().state, 'pending');
});

test('401 rejection is saved under the captured caller before session reset', async () => {
  const env = environment(async () => rejection('42501', 'permission denied', 401));
  await assert.rejects(env.request('edit', payload), /session expired/);
  assert.equal(env.receipt().state, 'confirmed');
  assert.equal(env.receipt().result.status, 'rejected');
});

// Use the bundled SDK with a fake fetch to cover its real response normalization.
for (const [label, fetch, expected] of [
  ['PostgreSQL rejection', async () => new Response(JSON.stringify({
    code: 'P0001', message: 'Invalid item values', details: null, hint: null,
  }), { status: 400 }), 'confirmed'],
  ['fetch rejection', async () => { throw new TypeError('Failed to fetch'); }, 'pending'],
  ['gateway HTML', async () => new Response('<html>Bad Gateway</html>', { status: 502 }), 'pending'],
]) {
  test(`bundled Supabase SDK: ${label}`, async () => {
    const sdkContext = vm.createContext({ URL, Headers, Request, Response,
      AbortController, setTimeout, clearTimeout, console, fetch,
      WebSocket: class { constructor() { throw new Error('Unexpected WebSocket connection'); } },
    });
    vm.runInContext(read('vendor/supabase-2.118.0.js'), sdkContext);
    const { createClient } = sdkContext.supabase;
    const sdk = createClient('https://grocery-review.invalid', 'test-key', {
      accessToken: async () => 'test-token', global: { fetch }, db: { retry: false },
    });
    const env = environment((name, args) => sdk.rpc(name, args));
    await assert.rejects(env.request('edit', payload));
    assert.equal(env.receipt().state, expected);
  });
}
