(() => {
  'use strict';
  if (location.origin !== 'http://localhost:3000') return;
  const config = window.PUBLIC_CONFIG;
  const expected = ['account-1@example.invalid', 'account-2@example.invalid']; // Sanitized placeholders, not accounts.
  const status = document.getElementById('status');
  const output = document.getElementById('results');
  const start = document.getElementById('start');
  const identityLabel = document.getElementById('identity');
  const channel = new BroadcastChannel('grocery-validation-' + window.RUN_ID);
  const workerId = crypto.randomUUID();
  const workers = new Map(), pending = new Map();
  let client, identity, testList, firstCreateAttempted = false, subscribed;
  let started = false, failed = false, step = 'Authentication prerequisites';
  const events = [];
  const sensitive = new Set();
  let fragment = new URLSearchParams(location.hash.slice(1));
  let access = fragment.get('access_token'), refresh = fragment.get('refresh_token');
  if (access) sensitive.add(access); if (refresh) sensitive.add(refresh);
  const callbackFailure = fragment.has('error') || fragment.has('error_code') || location.search.includes('code=') || location.search.includes('error=');
  history.replaceState(null, '', '/');
  fragment = null;
  const line = text => { const li = document.createElement('li'); li.textContent = text; output.append(li); };
  const check = result => { if (result.error) throw result.error; return result.data; };
  const fields = 'id,list_id,item_name,quantity,purchased,revision';
  const protocol = window.GroceryMutation;
  async function protectedMutation(operation, payload, list = testList) {
    return protocol.exclusive(identity.id, async () => {
      const saved = protocol.prepare(identity.id, operation === 'create' ? null : list, operation, payload, operation === 'add_items' ? { kind: 'add' } : undefined);
      const result = check(await protocol.execute(client, saved));
      if (operation === 'create' ? !/^[a-f0-9-]{36}$/i.test(result) : result?.status !== 'ok') throw problem('Protected mutation did not confirm success. Stop and reconcile the saved request.');
      if (operation === 'add_items') protocol.validateAddResult(saved, result);
      protocol.complete(saved, result);
      return result;
    });
  }
  const safeError = error => {
    let text = String(error?.validationMessage || error?.message || 'Request failed.');
    for (const value of sensitive) if (value) text = text.split(value).join('[redacted]');
    text = text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[token redacted]')
      .replace(/https?:\/\/[^\s]+/g, '[URL redacted]');
    return { code: /^[A-Za-z0-9_]{1,50}$/.test(error?.code || '') ? error.code : null,
      status: typeof error?.status === 'number' ? error.status : null, message: text };
  };
  const problem = text => Object.assign(new Error(text), { validationMessage: text });
  function announce() { if (identity) channel.postMessage({ kind: 'ready', workerId, email: identity.email }); }
  function ready() {
    document.getElementById('accounts').textContent = expected.map(email => `${email}: ${workers.has(email) ? 'verified session ready' : 'waiting for sign-in'}`).join(' | ');
    start.disabled = started || failed || expected.some(email => !workers.has(email));
  }
  const currentItem = async id => check(await client.from('grocery_items').select(fields).eq('list_id', testList).eq('id', id));
  async function action(name, args) {
    if (args.invite) sensitive.add(args.invite);
    if (!client || !identity) throw problem('Verified session unavailable. Stop.');
    if (name === 'create') {
      if (identity.email !== expected[0] || firstCreateAttempted) throw problem('Only one Account 1 list-creation attempt is allowed.');
      firstCreateAttempted = true;
      testList = await protectedMutation('create', {});
      if (!/^[0-9a-f-]{36}$/i.test(testList)) throw problem('Unexpected create-list response.');
      return testList;
    }
    if (name === 'join') {
      if (identity.email !== expected[1] || testList) throw problem('Unexpected join state.');
      const id = check(await client.rpc('redeem_grocery_list_invite', { invite_token: args.invite }));
      if (id !== args.list) throw problem('Invitation returned a different list. Stop.');
      testList = id; return id;
    }
    if (!testList || args.list !== testList) throw problem('Operation is not scoped to this newly created test list.');
    if (name === 'membership') {
      return check(await client.from('grocery_list_members').select('list_id,user_id').eq('list_id', testList).eq('user_id', identity.id));
    }
    if (name === 'invite') {
      if (identity.email !== expected[0]) throw problem('Only Account 1 may generate the test invitation.');
      const value = (await protectedMutation('invite', {})).token;
      sensitive.add(value); return value;
    }
    if (name === 'redeemAgain') {
      const result = await client.rpc('redeem_grocery_list_invite', { invite_token: args.invite });
      if (!result.error) throw problem('Used invitation unexpectedly succeeded.');
      if (!/invalid, expired, or already used/i.test(result.error.message || '')) throw result.error;
      return true;
    }
    if (name === 'subscribe') {
      events.length = 0;
      subscribed = client.channel('validation-' + workerId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'grocery_items', filter: `list_id=eq.${testList}` }, payload => {
          // Keep only this test list's record identifiers and event type.
          if (payload.new?.list_id === testList) events.push({ type: payload.eventType, id: String(payload.new.id), purchased: payload.new.purchased });
        });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(problem('Realtime subscription timed out after 15 seconds.')), 15000);
        subscribed.subscribe(state => {
          if (state === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
          else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(state)) { clearTimeout(timer); reject(problem(`Realtime subscription failed: ${state}.`)); }
        });
      }); return true;
    }
    if (name === 'add') {
      if (identity.email !== expected[0]) throw problem('Only Account 1 adds the one test item.');
      const receiptKey = `grocery-validation-add-v1:${identity.id}:${testList}`;
      if (localStorage.getItem(receiptKey) !== null) throw problem('A test item receipt already exists. Stop before another add.');
      const words = crypto.getRandomValues(new Uint32Array(2));
      const record = { id: -(1 + (words[0] & 0xfffff) * 4294967296 + words[1]),
        item_name: 'Milestone 2 Test Item', quantity: 1, purchased: false };
      // Historical runner receipts remain stop/review evidence, never RPC input.
      const result = await protectedMutation('add_items', { items: [record] });
      return result.items[0];
    }
    if (name === 'read') return currentItem(args.id);
    if (name === 'purchase') {
      if (identity.email !== expected[1]) throw problem('Only Account 2 changes the test purchased state.');
      const snapshot = args.snapshot;
      if (!snapshot || String(snapshot.id) !== String(args.id) || snapshot.list_id !== testList ||
          snapshot.item_name !== 'Milestone 2 Test Item' || snapshot.quantity !== 1 || snapshot.purchased !== false ||
          !/^[a-f0-9-]{36}$/i.test(snapshot.revision)) throw problem('Unexpected test item snapshot. Stop.');
      await protectedMutation('edit', {id:String(snapshot.id),revision:snapshot.revision,
        item_name:snapshot.item_name,quantity:snapshot.quantity,purchased:true});
      const rows = await currentItem(args.id);
      if (rows.length !== 1) throw problem('Updated item could not be verified.');
      return rows[0];
    }
    if (name === 'waitEvent') {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (events.some(event => event.type === args.type && event.id === String(args.id) && (args.type !== 'UPDATE' || event.purchased === true))) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw problem(`Realtime ${args.type} event was not received within 15 seconds. No polling substituted.`);
    }
    throw problem('Unsupported validation action.');
  }
  channel.onmessage = async ({ data }) => {
    if (data.kind === 'hello') { announce(); return; }
    if (data.kind === 'ready' && expected.includes(data.email)) { workers.set(data.email, data.workerId); ready(); return; }
    if (data.kind === 'response' && pending.has(data.id)) {
      const call = pending.get(data.id); if (data.workerId !== call.target) return;
      pending.delete(data.id); clearTimeout(call.timer);
      if (data.error) call.reject(Object.assign(problem(data.error.message), data.error)); else call.resolve(data.result);
      return;
    }
    if (data.kind === 'request' && data.target === workerId) {
      try { channel.postMessage({ kind: 'response', workerId, id: data.id, result: await action(data.action, data.args || {}) }); }
      catch (error) { channel.postMessage({ kind: 'response', workerId, id: data.id, error: safeError(error) }); }
    }
  };
  async function call(email, name, args = {}) {
    const target = workers.get(email);
    if (!target) throw problem('Required authenticated tab is unavailable.');
    if (target === workerId) return action(name, args);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(problem('Authenticated tab/request timed out. Outcome may be unknown. Do not repeat the test.')); }, 30000);
      pending.set(id, { target, timer, resolve, reject });
      channel.postMessage({ kind: 'request', target, id, action: name, args });
    });
  }
  function requireValue(condition, text) { if (!condition) throw problem(text); }
  start.addEventListener('click', async () => {
    if (started || failed) return;
    started = true; ready();
    let list;
    try {
      step = '1. Create one test list';
      list = await call(expected[0], 'create'); line('PASS 1: Account 1 created one new test list. Test list ID: ' + list);
      const args = { list };
      step = '2. Verify Account 1 membership';
      const membership1 = await call(expected[0], 'membership', args);
      requireValue(membership1.length === 1 && membership1[0].list_id === list, 'Account 1 membership did not match the test list.'); line('PASS 2: Account 1 membership verified.');
      step = '3. Create one invitation';
      const invite = await call(expected[0], 'invite', args); line('PASS 3: One invitation generated; token not displayed or saved.');
      step = '4. Redeem invitation with Account 2';
      requireValue(await call(expected[1], 'join', { list, invite }) === list, 'Account 2 joined a different list.'); line('PASS 4: Account 2 redeemed the invitation.');
      step = '5. Verify Account 2 membership';
      const membership2 = await call(expected[1], 'membership', args);
      requireValue(membership2.length === 1 && membership2[0].list_id === list, 'Account 2 membership did not match.'); line('PASS 5: Account 2 membership verified for the same list.');
      step = 'Invitation single-use check';
      await call(expected[1], 'redeemAgain', { list, invite }); line('PASS: Second invitation redemption rejected as invalid/expired/used.');
      step = '10 prerequisite. Establish Realtime subscriptions';
      await call(expected[0], 'subscribe', args); await call(expected[1], 'subscribe', args); line('PASS: Both authenticated Realtime subscriptions connected.');
      step = '7. Add one temporary test item';
      const item = await call(expected[0], 'add', args); requireValue(item.list_id === list && item.item_name === 'Milestone 2 Test Item' && item.purchased === false, 'Unexpected inserted item.'); line('PASS 7: Account 1 added Milestone 2 Test Item. Item ID: ' + item.id);
      step = '8 / 10. Account 2 receives INSERT event and reads item';
      await call(expected[1], 'waitEvent', { list, id: item.id, type: 'INSERT' });
      const read2 = await call(expected[1], 'read', { list, id: item.id });
      requireValue(read2.length === 1 && read2[0].item_name === item.item_name && read2[0].purchased === false, 'Account 2 could not read the inserted item.'); line('PASS 8: Account 2 received the live INSERT event and read the same item.');
      step = '9. Account 2 marks purchased';
      const purchased = await call(expected[1], 'purchase', { list, id: item.id, snapshot: read2[0] }); requireValue(purchased.purchased === true, 'Purchased state was not confirmed.'); line('PASS 9: Account 2 marked the test item purchased.');
      step = '6 / 10. Account 1 receives UPDATE event and reads purchased state';
      await call(expected[0], 'waitEvent', { list, id: item.id, type: 'UPDATE' });
      const read1 = await call(expected[0], 'read', { list, id: item.id });
      requireValue(read1.length === 1 && read1[0].purchased === true, 'Account 1 did not read the purchased state.'); line('PASS 6 / 10: Both accounts accessed the test list through RLS; Account 1 received the live UPDATE and read purchased=true.');
      status.textContent = 'ALL CONTROLLED TESTS PASSED. Stopped. Report these results to Codex. Test list and purchased test item were retained; no cleanup or other operations ran.';
    } catch (error) {
      failed = true;
      const detail = safeError(error);
      status.textContent = 'STOPPED at ' + step + ': ' + detail.message + (detail.code ? ' Code: ' + detail.code : '') + (detail.status ? ' HTTP: ' + detail.status : '') + '. Do not rerun or change settings. Report the displayed results.';
      line('No later steps or cleanup were attempted. Prior PASS entries describe completed operations. A timed-out request may have completed on the server.');
    }
  });
  channel.postMessage({ kind: 'hello' }); ready();
  if (callbackFailure) { status.textContent = 'Authentication callback failed or used an unexpected flow. STOP; do not retry or share the link.'; return; }
  if (!access || !refresh) { status.textContent = 'READY: local validation runner is running. Do not start until both accounts are verified in separate tabs.'; return; }
  status.textContent = 'Verifying the signed-in identity...';
  (async () => {
    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      db: { retry: false, timeout: 20000 }
    });
    check(await client.auth.setSession({ access_token: access, refresh_token: refresh }));
    access = null; refresh = null;
    identity = check(await client.auth.getUser()).user;
    requireValue(expected.includes(identity.email?.toLowerCase()) && identity.is_anonymous === false && identity.email_confirmed_at, 'Unexpected or unconfirmed authenticated identity.');
    identity.email = identity.email.toLowerCase();
    workers.set(identity.email, workerId); announce(); ready();
    identityLabel.textContent = 'Verified account in this tab: ' + identity.email;
    status.textContent = 'VERIFIED: ' + identity.email + '. Keep this tab open; no grocery requests have run. Wait for the other account, then follow Codex instructions.';
  })().catch(error => {
    access = null; refresh = null; client = null; identity = null;
    status.textContent = 'STOP: authentication verification failed. No grocery requests ran. ' + safeError(error).message;
  });
})();
