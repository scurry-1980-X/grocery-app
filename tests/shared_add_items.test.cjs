const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '../reviews/shared-client-recovery-2026-10-19');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const caller = '11111111-1111-4111-8111-111111111111';
const list = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const mutationKey = `grocery-mutation-v1:${caller}`;
const legacyKey = target => `grocery-save-v1:${caller}:${target}`;
const marker = target => `grocery-imported-v1:${caller}:${target}`;
const entry = (name = 'Milk') => ({ name, quantity: 1, done: false });
const row = (id = -1) => ({ id, item_name: 'Milk', quantity: 1, purchased: false, list_id: list, owner_id: caller });
const reject = (code, message, status = 400) => ({ data: null, error: { code, message }, status });
const answer = args => ({ status: 'ok', items: args.payload.items.map(item => ({ ...item,
  id: String(item.id), list_id: args.target_list_id, owner_id: caller,
  revision: crypto.randomUUID(), created_at: '2026-10-20T12:00:00+00:00',
})) });

// Actual protocol/shared client, with an unshipped closure seam. The SDK boundary,
// DOM, storage and transport are substitutes; the browser suite covers real locks.
function environment(options = {}) {
  const storage = options.storage || new Map(), events = [], calls = [], reads = [], elements = new Map();
  const listeners = new Map(), windowListeners = new Map();
  let activeLocks = 0;
  const element = id => ({ value: '', children: [], hidden: false, textContent: '',
    addEventListener(name, fn) { listeners.set(`${id}:${name}`, fn); },
    replaceChildren(...children) { this.children = children; if (id === 'legacy-receipts') this.value = children[0]?.value || ''; },
    querySelectorAll: () => [], querySelector() { return this; }, append() {}, focus() {}, select() {},
    setCustomValidity() {}, reportValidity() {}, setAttribute() {}, dataset: {},
  });
  for (const [, id] of read('client/index.html').matchAll(/\bid="([^"]+)"/g)) elements.set(id, element(id));
  const localStorage = {
    get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null,
    getItem(key) { options.beforeRead?.(key, storage); return storage.get(key) ?? null; },
    setItem(key, value) { events.push(['store', key]); options.beforeWrite?.(key, value, storage); storage.set(key, value); },
  };
  const client = {
    auth: {
      async getSession() { await options.beforeSession?.(); return { data: { session: {
        user: { id: options.sessionUser || caller }, access_token: 'memory-only-token',
      } }, error: null }; },
      async getUser(token) { assert.equal(token, 'memory-only-token'); await options.beforeUser?.(); return { data: { user: { id: options.verifiedUser || caller } } }; },
    },
    async rpc(name, args) {
      events.push(['rpc', name]); calls.push(plain(args));
      return options.rpc ? options.rpc(name, args) : { data: answer(args), error: null, status: 200 };
    },
    from(table) {
      const q = { table, select(fields) { this.fields = fields; return this; },
        eq(key, value) { this[key] = value; return this; }, order() { return this; },
        async range() { if (options.refreshError) throw new Error('Refresh unavailable'); return { data: [], error: null }; },
        async in(key, ids) {
          reads.push({ table, fields: this.fields, list: this.list_id, ids: plain(ids) });
          return options.select ? options.select(this, ids) : { data: [], error: null };
        },
        insert() { assert.fail('Direct INSERT is forbidden'); },
      }; return q;
    },
  };
  const window = { GROCERY_SHARED_CONFIG: { url: 'https://grocery-review.invalid', publishableKey: 'sb_publishable_fixture' },
    supabase: { createClient(url, key, settings) {
      assert.equal(url, 'https://grocery-review.invalid'); assert.equal(settings.db.retry, false);
      return { async rpc(name, args) {
        const token = await settings.accessToken(); assert.equal(token, 'memory-only-token');
        return client.rpc(name, args);
      } };
    } }, addEventListener: (name, fn) => windowListeners.set(name, fn), confirm: () => true };
  if (options.sdk) window.supabase = options.sdk;
  const context = vm.createContext({ window, localStorage, crypto: options.crypto || crypto.webcrypto,
    navigator: { onLine: true, locks: { async request(name, task) {
      assert.equal(name, `grocery-write:${caller}`); assert.equal(activeLocks, 0, 'nested Web Lock');
      activeLocks++; try { await options.beforeLock?.(); return await task(); } finally { activeLocks--; }
    } } }, clearInterval() {},
    document: { getElementById: id => elements.get(id), createElement: () => element('dynamic'), addEventListener() {} },
    testClient: client, testCaller: caller, testList: list,
  });
  vm.runInContext(read('client/mutation-protocol.js'), context);
  const source = read('client/shared.js');
  vm.runInContext(source.slice(0, -6) + `
    client = testClient; user = { id: testCaller }; listId = testList; active = true; loaded = true;
    window.test = { addBatch, protectedRequest, reconcileLegacy, controls, mutate, run,
      change(id = testList, account = testCaller) { epoch++; listId = id; user = { id: account }; },
      resetCloud, repairImportMarker };
  })();`, context);
  const api = window.test, protocol = window.GroceryMutation;
  return { ...api, protocol, calls, reads, events, storage, localStorage, elements, listeners, windowListeners, context,
    saved: () => plain(protocol.read(caller)),
    blocked() { api.controls(); return elements.get('cloud-submit').disabled; },
  };
}
const add = (env, entries = [entry()]) => env.addBatch(entries, 'add');
const resume = env => env.protectedRequest(null, null, true);
function legacy(env, records = [row()], kind = 'add', target = list, state = 'pending') {
  const receipt = { state, kind, records };
  if (kind === 'import') receipt.source = JSON.stringify(records.map(r => ({ name: r.item_name, quantity: r.quantity, done: r.purchased })));
  env.storage.set(legacyKey(target), JSON.stringify(receipt)); return receipt;
}

test('new single/batch adds persist before RPC with server-derived ownership and stable IDs', async () => {
  for (const entries of [[entry()], [entry('Milk'), { name: 'Bread', quantity: 999, done: false }]]) {
    const env = environment(); const result = await add(env, entries);
    assert.equal(env.calls.length, 1); assert.equal(result.saved.operation, 'add_items');
    assert.equal(env.calls[0].target_list_id, list);
    assert.deepEqual(env.events[0], ['store', mutationKey]);
    assert.deepEqual(env.calls[0].payload.items.map(x => x.item_name), entries.map(x => x.name));
    for (const item of env.calls[0].payload.items) {
      assert.ok(Number.isSafeInteger(item.id) && item.id < 0);
      assert.deepEqual(Object.keys(item).sort(), ['id', 'item_name', 'purchased', 'quantity']);
    }
    assert.equal(new Set(env.calls[0].payload.items.map(x => x.id)).size, entries.length);
    assert.equal(env.saved().state, 'confirmed'); assert.equal(env.storage.has(legacyKey(list)), false);
    assert.ok(!JSON.stringify([...env.storage]).includes('memory-only-token'));
  }
});

const corpus = JSON.parse(execFileSync(process.execPath,
  [path.join(__dirname, 'migration003_name_validation.test.cjs'), '--emit-cases'], { encoding: 'utf8' }));
for (const c of corpus) test(`add name contract: ${c.label}`, async () => {
  const env = environment();
  if (c.accepted) { await add(env, [entry(c.name)]); assert.equal(env.calls[0].payload.items[0].item_name, c.name); }
  else { await assert.rejects(add(env, [{ name: c.name, quantity: 1, done: false }])); assert.equal(env.calls.length, 0); }
});

test('batch and quantity bounds reject whole batch; 200 and safe-ID boundaries accepted', async () => {
  for (const count of [0, 201]) {
    const env = environment(); await assert.rejects(add(env, Array.from({ length: count }, () => entry()))); assert.equal(env.calls.length, 0);
  }
  for (const quantity of [0, 1000, 1.5, '1', null]) {
    const env = environment(); await assert.rejects(add(env, [entry(), { ...entry(), quantity }])); assert.equal(env.calls.length, 0);
  }
  const env = environment(); await add(env, Array.from({ length: 200 }, () => entry()));
  assert.equal(env.calls[0].payload.items.length, 200);
  const payload = { items: [{ id: -9007199254740991, item_name: 'Milk', quantity: 1, purchased: true }] };
  env.protocol.validateAddPayload(payload);
  for (const id of [0, 1, '-1', -1.5, -9007199254740992, null]) {
    assert.throws(() => env.protocol.validateAddPayload({ items: [{ ...payload.items[0], id }] }));
  }
  assert.throws(() => env.protocol.validateAddPayload({ items: [payload.items[0], payload.items[0]] }));
  assert.throws(() => env.protocol.validateAddPayload({ items: [{ ...payload.items[0], owner_id: caller }] }));
});

test('random collisions are retried only before persistence, bounded RNG failure sends nothing', async () => {
  const fakeCrypto = { randomUUID: () => crypto.randomUUID(), getRandomValues: a => { a.fill(0); return a; } };
  const env = environment({ crypto: fakeCrypto });
  await assert.rejects(add(env, [entry(), entry('Bread')]), /unique item IDs/);
  assert.equal(env.calls.length, 0); assert.equal(env.storage.has(mutationKey), false);
});

for (const failure of ['read', 'write', 'readback']) test(`pre-send storage ${failure} failure sends nothing`, async () => {
  let reads = 0;
  const env = environment({
    beforeRead(key, store) {
      if (key === mutationKey) {
        reads++; if (failure === 'read') throw new Error('Storage read unavailable');
        if (failure === 'readback' && store.has(key)) throw new Error('Read-back unavailable');
      }
    },
    beforeWrite(key) { if (failure === 'write' && key === mutationKey) throw new Error('Quota exceeded'); },
  });
  await assert.rejects(add(env)); assert.equal(env.calls.length, 0); assert.ok(reads);
});

test('lost committed response survives reload and edit/delete; exact payload and ID replay', async () => {
  const ledger = new Map(); let effects = 0;
  const rpc = async (_, args) => {
    if (ledger.has(args.request_id)) return { data: ledger.get(args.request_id) };
    effects++; ledger.set(args.request_id, answer(args)); throw new TypeError('Response lost after commit');
  };
  const first = environment({ rpc }); await assert.rejects(add(first, [entry(), entry('Bread')]));
  const saved = first.saved(); first.storage.set('my-groceries-v1', JSON.stringify([entry('Changed later')]));
  // There are deliberately no current rows. Only the immutable ledger remains.
  const reloaded = environment({ rpc, storage: first.storage });
  reloaded.elements.get('cloud-name').value = 'Different input';
  await resume(reloaded);
  assert.equal(effects, 1); assert.deepEqual(reloaded.calls[0], first.calls[0]);
  assert.equal(reloaded.saved().requestId, saved.requestId); assert.equal(reloaded.saved().state, 'confirmed');
  assert.equal(reloaded.reads.length, 0);
});

for (const [label, response] of [
  ['fetch', () => { throw new TypeError('Failed to fetch'); }],
  ['timeout', () => { throw new Error('Timed out'); }],
  ['408', () => reject('P0001', 'Invalid add item', 408)],
  ['429', () => reject('P0001', 'Invalid add item', 429)],
  ['gateway', () => reject('', 'Bad Gateway', 502)],
  ['SQL connection', () => reject('08006', 'connection failed', 503)],
  ['serialization', () => reject('40001', 'serialization failed', 500)],
  ['permission', () => reject('42501', 'denied', 403)],
  ['membership', () => reject('P0001', 'You are not a member of this grocery list')],
  ['collision', () => reject('23505', 'duplicate key', 409)],
  ['unsupported', () => reject('P0001', 'Unsupported mutation')],
  ['missing RPC', () => reject('PGRST202', 'missing function', 404)],
  ['mismatch', () => reject('P0001', 'Request ID already used with a different operation or payload')],
  ['missing ledger', () => reject('P0001', 'Result unavailable; retry the same request')],
  ['incomplete ledger', () => reject('P0001', 'Incomplete mutation result')],
  ['unknown', () => reject('P0001', 'Unknown error')],
]) test(`add ${label} preserves pending identity and blocks fresh requests`, async () => {
  const env = environment({ rpc: response }); await assert.rejects(add(env)); const saved = env.saved();
  assert.equal(saved.state, 'pending'); assert.equal(env.blocked(), true);
  await assert.rejects(add(env)); assert.equal(env.calls.length, 1);
  await assert.rejects(resume(env)); assert.deepEqual(env.calls[0], env.calls[1]); assert.deepEqual(env.saved(), saved);
});

for (const message of ['Add requires an items array', 'Add batch must contain 1 to 200 items',
  'Invalid add item', 'Invalid item values', 'Duplicate add item ID']) {
  test(`post-ledger validation rejection permits a later explicit correction: ${message}`, async () => {
    let rejected = true;
    const env = environment({ rpc: (_, args) => rejected ? reject('P0001', message) : { data: answer(args) } });
    await assert.rejects(add(env)); const original = env.saved();
    assert.equal(original.result.status, 'rejected'); assert.equal(env.blocked(), false);
    rejected = false; await add(env, [entry('Corrected')]); assert.notEqual(env.saved().requestId, original.requestId);
  });
}

test('commit then revoke access retains uncertainty until original caller regains access', async () => {
  let result, phase = 0;
  const env = environment({ rpc: (_, args) => {
    if (phase++ === 0) { result = answer(args); throw new TypeError('Lost response'); }
    return phase === 2 ? reject('P0001', 'You are not a member of this grocery list') : { data: result };
  } });
  await assert.rejects(add(env)); const original = env.saved();
  await assert.rejects(resume(env)); assert.deepEqual(env.saved(), original);
  await resume(env); assert.deepEqual(env.saved().result, plain(result)); assert.deepEqual(env.calls[0], env.calls[2]);
});

for (const [label, corrupt] of [
  ['missing item', r => r.items.pop()], ['extra item', r => r.items.push(r.items[0])],
  ['duplicate IDs', r => { r.items[1] = r.items[0]; }], ['order', r => r.items.reverse()],
  ['wrong ID', r => { r.items[0].id = '-999'; }], ['numeric ID', r => { r.items[0].id = -1; }],
  ['owner', r => { r.items[0].owner_id = other; }], ['list', r => { r.items[0].list_id = other; }],
  ['name', r => { r.items[0].item_name = 'Wrong'; }], ['quantity', r => { r.items[0].quantity = 9; }],
  ['purchased', r => { r.items[0].purchased = true; }], ['revision', r => { r.items[0].revision = 'bad'; }],
  ['timestamp', r => { r.items[0].created_at = '1'; }], ['conflict', r => { r.status = 'conflict'; }],
]) test(`malformed add result ${label} cannot confirm`, async () => {
  const env = environment({ rpc: (_, args) => { const result = answer(args); corrupt(result); return { data: result }; } });
  await assert.rejects(add(env, [entry(), entry('Bread')])); assert.equal(env.saved().state, 'pending');
});

for (const boundary of ['marker', 'confirmation']) test(`import recovery after ${boundary} storage failure uses original snapshot`, async () => {
  const source = JSON.stringify([entry(), { name: 'Bread', quantity: 2, done: true }]);
  let fail = true, effects = 0; const ledger = new Map();
  const rpc = (_, args) => {
    if (!ledger.has(args.request_id)) { effects++; ledger.set(args.request_id, answer(args)); }
    return { data: ledger.get(args.request_id) };
  };
  const first = environment({ rpc, beforeWrite(key, value) {
    if (fail && ((boundary === 'marker' && key === marker(list)) ||
        (boundary === 'confirmation' && key === mutationKey && JSON.parse(value).state === 'confirmed'))) throw new Error('Storage blocked');
  } });
  first.storage.set('my-groceries-v1', source);
  await assert.rejects(first.addBatch(JSON.parse(source), 'import', source));
  assert.equal(first.saved().state, 'pending'); assert.equal(first.storage.get('my-groceries-v1'), source);
  const reloaded = environment({ rpc, storage: first.storage });
  reloaded.storage.set('my-groceries-v1', JSON.stringify([entry('Changed while pending')]));
  await resume(reloaded); assert.equal(effects, 1); assert.equal(reloaded.storage.get(marker(list)), source);
  assert.deepEqual(reloaded.calls[0], first.calls[0]);
  const writes = reloaded.events.filter(e => e[0] === 'store').map(e => e[1]);
  assert.deepEqual(writes, [marker(list), mutationKey]);
  await assert.rejects(reloaded.addBatch(JSON.parse(source), 'import', source), /already imported/);
  await add(reloaded); assert.equal(reloaded.storage.get(marker(list)), source);
});

test('lost import marker is repaired before a confirmed receipt is overwritten', async () => {
  const env = environment(), source = JSON.stringify([entry()]);
  await env.addBatch(JSON.parse(source), 'import', source); env.storage.delete(marker(list));
  await add(env, [entry('Later')]); assert.equal(env.storage.get(marker(list)), source);
});

test('import source must match payload and booleans; corrupt pending receipt fails closed', async () => {
  const env = environment();
  await assert.rejects(env.addBatch([entry()], 'import', JSON.stringify([entry('Other')])));
  await assert.rejects(env.addBatch([{ ...entry(), done: 'false' }], 'import', '[]'));
  assert.equal(env.calls.length, 0);
  env.storage.set(mutationKey, '{bad json'); await assert.rejects(add(env)); assert.equal(env.blocked(), true);
});

for (const [label, getRows] of [
  ['absent', () => []], ['partial', () => [row()]], ['changed', () => [row(), { ...row(-2), item_name: 'Changed' }]],
  ['owner', () => [row(), { ...row(-2), owner_id: other }]], ['list', () => [row(), { ...row(-2), list_id: other }]],
  ['duplicates', () => [row(), row()]], ['malformed', () => [null, row()]], ['non-array', () => ({})],
  ['extra', () => [row(), row(-2), row(-3)]],
]) test(`legacy ${label} is SELECT-only and stays unresolved`, async () => {
  const env = environment({ select: () => ({ data: getRows() }) });
  const saved = legacy(env, [row(), row(-2)]);
  await assert.rejects(env.reconcileLegacy(list));
  assert.deepEqual(JSON.parse(env.storage.get(legacyKey(list))), saved); assert.equal(env.calls.length, 0);
  assert.equal(env.reads[0].fields, 'id,list_id,owner_id,item_name,quantity,purchased');
  await assert.rejects(add(env)); assert.equal(env.calls.length, 0);
});

test('legacy inaccessible, malformed receipts, and revoked unselected lists stay blocked', async () => {
  const env = environment({ select: () => reject('42501', 'access denied', 403) });
  legacy(env, [{ ...row(), list_id: other }], 'add', other);
  await assert.rejects(env.reconcileLegacy(other)); assert.equal(env.blocked(), true);
  env.storage.set(legacyKey(list), '{broken'); await assert.rejects(add(env)); assert.equal(env.calls.length, 0);
});

test('legacy exact match confirms observed save and import marker without inserting', async () => {
  const env = environment({ select: () => ({ data: [{ ...row(-2), id: '-2' }, row()] }) });
  const saved = legacy(env, [row(), row(-2)], 'import'); await env.reconcileLegacy(list);
  assert.equal(env.calls.length, 0); assert.equal(JSON.parse(env.storage.get(legacyKey(list))).state, 'confirmed');
  assert.equal(env.storage.get(marker(list)), saved.source);
  assert.deepEqual(env.events.filter(e => e[0] === 'store').map(e => e[1]), [marker(list), legacyKey(list)]);
  // Confirmed receipts are never downgraded or reinserted after later deletion.
  await env.reconcileLegacy(list); assert.equal(env.reads.length, 1);
  await assert.rejects(env.addBatch(JSON.parse(saved.source), 'import', saved.source), /already imported/);
});

test('both pending receipt types are visible and independently recoverable', async () => {
  let fail = true;
  const env = environment({ rpc: (_, args) => { if (fail) throw new Error('Lost'); return { data: answer(args) }; },
    select: () => ({ data: [row()] }) });
  await assert.rejects(add(env)); legacy(env); env.controls();
  assert.equal(env.elements.get('check-pending').hidden, false); assert.equal(env.elements.get('legacy-recovery').hidden, false);
  await env.reconcileLegacy(list); assert.equal(env.saved().state, 'pending');
  legacy(env); fail = false; await resume(env);
  assert.equal(env.saved().state, 'confirmed'); assert.equal(JSON.parse(env.storage.get(legacyKey(list))).state, 'pending');
  await assert.rejects(add(env)); await env.reconcileLegacy(list); await add(env);
});

for (const timing of ['lock', 'auth', 'response']) test(`context change at ${timing} retains original receipt and never retargets`, async () => {
  let env;
  const opts = timing === 'lock' ? { beforeLock: () => env.change(other) }
    : timing === 'auth' ? { beforeUser: () => env.change(other, other) }
    : { rpc: (_, args) => { env.change(other); return { data: answer(args) }; } };
  env = environment(opts); await assert.rejects(add(env));
  assert.equal(env.calls.length, timing === 'response' ? 1 : 0);
  if (timing !== 'lock') { assert.equal(env.saved().state, 'pending'); assert.equal(env.saved().listId, list); }
});

test('resume from another selected list uses original list and import marker', async () => {
  const env = environment({ rpc: () => { throw new Error('Lost response'); } });
  const source = JSON.stringify([entry()]); await assert.rejects(env.addBatch(JSON.parse(source), 'import', source));
  const reloaded = environment({ storage: env.storage }); reloaded.change(other); await resume(reloaded);
  assert.equal(reloaded.calls[0].target_list_id, list); assert.equal(reloaded.storage.get(marker(list)), source);
  assert.equal(reloaded.storage.has(marker(other)), false);
});

for (const which of ['sessionUser', 'verifiedUser']) test(`wrong ${which} cannot dispatch caller's receipt`, async () => {
  const env = environment({ [which]: other }); await assert.rejects(add(env));
  assert.equal(env.calls.length, 0); assert.equal(env.saved().state, 'pending');
});

test('confirmed add stays confirmed after list refresh fails', async () => {
  const env = environment({ refreshError: true });
  await env.mutate(() => add(env), 'Saved.');
  assert.equal(env.saved().state, 'confirmed'); assert.match(env.elements.get('cloud-status').textContent, /Saved.*Refresh failed/);
  assert.equal(env.blocked(), true);
});

test('legacy storage events update gates; no Web Locks fails closed', async () => {
  const env = environment(); legacy(env); env.windowListeners.get('storage')({ key: legacyKey(list) });
  assert.equal(env.elements.get('cloud-submit').disabled, true);
  const fresh = environment(); vm.runInContext('navigator.locks = undefined', fresh.context);
  await assert.rejects(add(fresh), /coordinate shared writes/); assert.equal(fresh.calls.length, 0);
});

test('completion refuses to overwrite a replaced request; old protocol fails closed on add_items', async () => {
  const env = environment({ rpc: () => { throw new Error('Lost'); } }); await assert.rejects(add(env));
  const saved = env.saved(); const changed = { ...saved, requestId: crypto.randomUUID() };
  env.storage.set(mutationKey, JSON.stringify(changed));
  assert.throws(() => env.protocol.complete(saved, answer(env.calls[0])), /receipt changed/);
  const old = execFileSync('git', ['show', '4a22d15:reviews/shared-client-recovery-2026-10-19/client/mutation-protocol.js'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  vm.runInContext(old, env.context);
  assert.throws(() => vm.runInContext(`window.GroceryMutation.read('${caller}')`, env.context), /needs review/);
});

for (const scenario of ['ok', 'fetch', 'gateway', 'validation', 'auth']) test(`actual SDK add transport: ${scenario}`, async () => {
  const sent = [];
  const fetch = async (url, options) => {
    const args = JSON.parse(options.body); sent.push(args);
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer memory-only-token');
    assert.match(url, /\/rest\/v1\/rpc\/mutate_grocery_once$/);
    if (scenario === 'fetch') throw new TypeError('Failed to fetch');
    if (scenario === 'gateway') return new Response('<html>gateway</html>', { status: 502 });
    const data = scenario === 'validation' ? { code: 'P0001', message: 'Invalid add item' }
      : scenario === 'auth' ? { code: '42501', message: 'permission denied' } : answer(args);
    return new Response(JSON.stringify(data), { status: scenario === 'validation' ? 400 : scenario === 'auth' ? 401 : 200 });
  };
  const sdkContext = vm.createContext({ URL, Headers, Request, Response, AbortController, setTimeout, clearTimeout, console, fetch,
    WebSocket: class { constructor() { throw new Error('Unexpected connection'); } } });
  vm.runInContext(read('client/vendor/supabase-2.118.0.js'), sdkContext);
  const env = environment({ sdk: sdkContext.supabase });
  if (scenario === 'ok') await add(env); else await assert.rejects(add(env));
  assert.equal(sent.length, 1); assert.equal(env.saved().state, ['ok', 'validation'].includes(scenario) ? 'confirmed' : 'pending');
  if (scenario === 'validation') assert.equal(env.saved().result.status, 'rejected');
  assert.ok(!JSON.stringify([...env.storage]).includes('memory-only-token'));
});

test('failed rejection/confirmation persistence leaves recoverable pending evidence', async () => {
  for (const status of ['ok', 'rejected']) {
    const env = environment({ rpc: (_, args) => status === 'ok' ? { data: answer(args) } : reject('P0001', 'Invalid add item'),
      beforeWrite(key, value) { if (key === mutationKey && JSON.parse(value).state === 'confirmed') throw new Error('Quota exceeded'); } });
    await assert.rejects(add(env)); assert.equal(env.saved().state, 'pending'); assert.equal(env.blocked(), true);
  }
});

test('empty stored values and unknown add intent metadata fail closed', async () => {
  for (const key of [mutationKey, legacyKey(list)]) {
    const env = environment(); env.storage.set(key, ''); await assert.rejects(add(env)); assert.equal(env.calls.length, 0);
  }
  const env = environment({ rpc: () => { throw new Error('Lost'); } }); await assert.rejects(add(env));
  const saved = env.saved(); saved.intent = { kind: 'unknown' }; env.storage.set(mutationKey, JSON.stringify(saved));
  await assert.rejects(resume(env)); assert.equal(env.calls.length, 1);
});

test('legacy receipt changes and confirmation-storage failures never allow insertion', async () => {
  let env;
  env = environment({ select: () => { const saved = JSON.parse(env.storage.get(legacyKey(list))); saved.records[0].quantity = 9;
    env.storage.set(legacyKey(list), JSON.stringify(saved)); return { data: [row()] }; } });
  legacy(env); await assert.rejects(env.reconcileLegacy(list), /receipt changed/); assert.equal(env.calls.length, 0);
  const fail = environment({ select: () => ({ data: [row()] }), beforeWrite: () => { throw new Error('Storage blocked'); } });
  legacy(fail); await assert.rejects(fail.reconcileLegacy(list)); assert.equal(JSON.parse(fail.storage.get(legacyKey(list))).state, 'pending');
  assert.equal(fail.calls.length, 0);
});

test('malformed receipts do not hide independently recoverable legacy or RPC history', async () => {
  const env = environment({ rpc: async () => { throw new Error('Lost response'); } });
  await assert.rejects(add(env));
  env.storage.set(legacyKey(other), '');
  env.controls();
  assert.equal(env.elements.get('check-pending').hidden, false);
  assert.equal(env.blocked(), true);
  legacy(env);
  env.storage.set(mutationKey, '');
  env.controls();
  assert.equal(env.elements.get('check-pending').hidden, true);
  assert.equal(env.elements.get('legacy-recovery').hidden, false);
  assert.equal(env.elements.get('legacy-receipts').children.length, 1);
  assert.equal(env.blocked(), true);
  assert.match(env.elements.get('recovery-summary').textContent, /needs review/);
});

// Run the actual runner's initialization and action functions, without starting
// its historical workflow, network helper or authentication flow.
function runnerEnvironment(options = {}) {
  const env = environment(options);
  const source = read('runner/runner.js');
  const cut = source.indexOf("  channel.postMessage({ kind: 'hello' }); ready();");
  assert.ok(cut > 0);
  Object.assign(env.context, {
    location: { origin: 'http://localhost:3000', hash: '', search: '' },
    history: { replaceState() {} }, URLSearchParams,
    BroadcastChannel: class { postMessage() {} },
    runnerClient: { rpc: async (name, args) => {
      env.calls.push(plain(args));
      return options.rpc ? options.rpc(name, args) : { data: answer(args), error: null };
    } },
  });
  for (const id of ['status', 'results', 'start', 'identity']) {
    env.elements.set(id, { addEventListener() {}, append() {} });
  }
  vm.runInContext(source.slice(0, cut) + `
    client = runnerClient; identity = {id: testCaller, email: expected[0]}; testList = testListFixture;
    window.runnerAction = action;
  })();`, Object.assign(env.context, { testListFixture: list }));
  return { ...env, action: () => env.context.window.runnerAction('add', { list }) };
}

test('actual runner add uses the protocol and keeps historical direct-INSERT receipts stop-only', async () => {
  const env = runnerEnvironment();
  const result = await env.action();
  assert.equal(result.item_name, 'Milestone 2 Test Item');
  assert.equal(env.calls[0].operation, 'add_items');
  assert.equal(env.saved().state, 'confirmed');
  assert.deepEqual(Object.keys(env.calls[0].payload.items[0]).sort(), ['id', 'item_name', 'purchased', 'quantity']);
  for (const old of ['', 'broken', JSON.stringify({ state: 'pending', record: row() })]) {
    const blocked = runnerEnvironment();
    blocked.storage.set(`grocery-validation-add-v1:${caller}:${list}`, old);
    await assert.rejects(blocked.action(), /receipt already exists/);
    assert.equal(blocked.calls.length, 0);
    assert.equal(blocked.storage.get(`grocery-validation-add-v1:${caller}:${list}`), old);
  }
});

test('actual runner lost response preserves the pending request and stops a fresh add', async () => {
  const env = runnerEnvironment({ rpc: async () => { throw new Error('Lost response'); } });
  await assert.rejects(env.action(), /Lost response/);
  const pending = env.saved();
  await assert.rejects(env.action(), /earlier unconfirmed/);
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.saved(), pending);
  const retry = runnerEnvironment({ storage: env.storage });
  const result = await retry.protocol.execute(retry.context.runnerClient, retry.protocol.read(caller));
  retry.protocol.complete(retry.protocol.read(caller), result.data);
  assert.deepEqual(retry.calls[0], env.calls[0]);
  assert.equal(retry.saved().state, 'confirmed');
});
