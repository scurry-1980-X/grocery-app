/* Shared mode is opt-in. The local page script and its storage key stay independent. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let client, user, listId, rows = [], editing = null;
  let active = false, busy = false, loaded = false, epoch = 0;
  let failureVisible = false, signupBlockedUntil = 0;
  let channel, poll, refreshing = false, sdkLoading, readVersion = 0;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const message = text => { $('cloud-status').textContent = text; };
  const protocol = window.GroceryMutation;
  const isEmailUser = session => session?.user && !session.user.is_anonymous && session.user.email;

  function check(result) {
    if (result.error) {
      if (result.status === 401 || result.error.status === 401 || ['PGRST301', 'PGRST303', 'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'bad_jwt'].includes(result.error.code)) {
        resetCloud();
        failureVisible = true;
        const text = 'Your session expired or is no longer valid. Please sign in again. Local groceries are unchanged.';
        message(text);
        throw new Error(text);
      }
      throw result.error;
    }
    return result.data;
  }
  function context() {
    const current = epoch;
    return () => {
      if (current !== epoch || !active || !user || !listId) {
        throw new Error('The account or list changed. Reopen the shared list.');
      }
    };
  }
  function receiptAt(caller, target) {
    const value = localStorage.getItem(`grocery-save-v1:${caller}:${target}`);
    if (value === null) return null;
    let saved;
    try { saved = JSON.parse(value); } catch { /* handled as unsafe below */ }
    if (!uuid.test(target) || !saved || !['pending', 'confirmed'].includes(saved.state) || !['add', 'import'].includes(saved.kind) ||
        (saved.kind === 'import' && typeof saved.source !== 'string') || !Array.isArray(saved.records) ||
        !saved.records.length || saved.records.length > 200 || saved.records.some(row =>
          !row || !Number.isSafeInteger(row.id) || row.id >= 0 || row.list_id !== target || row.owner_id !== caller ||
          typeof row.item_name !== 'string' || !row.item_name.trim() || row.item_name.length > 150 ||
          !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 999 || typeof row.purchased !== 'boolean') ||
        new Set(saved.records.map(row => row.id)).size !== saved.records.length) {
      throw new Error('Saved receipt needs review. Nothing was sent or removed. Keep the local copy and request a data review.');
    }
    if (saved.kind === 'import') {
      let entries;
      try { entries = JSON.parse(saved.source); } catch { /* fail closed */ }
      if (!Array.isArray(entries) || entries.length !== saved.records.length || entries.some((entry, i) =>
          !entry || entry.name !== saved.records[i].item_name || entry.quantity !== saved.records[i].quantity ||
          entry.done !== saved.records[i].purchased)) throw new Error('Saved import source needs review. Nothing was sent.');
    }
    return saved;
  }
  function receipt() { return receiptAt(user.id, listId); }
  function legacyReceipts(caller, errors) {
    const prefix = `grocery-save-v1:${caller}:`;
    const found = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        const target = key.slice(prefix.length);
        try {
          const saved = receiptAt(caller, target);
          if (saved?.state === 'pending') found.push({ listId: target, saved });
        } catch (error) {
          if (!errors) throw error;
          errors.push(error.message);
        }
      }
    }
    return found.sort((a, b) => a.listId.localeCompare(b.listId));
  }
  function noLegacyPending(caller) {
    if (legacyReceipts(caller).length) throw new Error('Check the earlier unconfirmed legacy save first. No new request was prepared.');
  }
  function storeVerified(key, value) {
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error('Browser storage could not be verified. Keep the recovery receipt.');
  }
  function importKey(caller, target) { return `grocery-imported-v1:${caller}:${target}`; }
  function repairImportMarker(caller) {
    const saved = protocol.read(caller);
    // Confirmation is only written after the marker. Repair a subsequently lost
    // marker before this single-slot receipt can be overwritten by another action.
    if (saved?.state === 'confirmed' && saved.operation === 'add_items' && saved.result.status === 'ok' &&
        saved.intent.kind === 'import' && localStorage.getItem(importKey(caller, saved.listId)) === null) {
      storeVerified(importKey(caller, saved.listId), saved.intent.source);
    }
  }
  function controls() {
    for (const el of $('shared-mode').querySelectorAll('button, input, select')) el.disabled = busy;
    $('local-mode-button').disabled = busy;
    $('shared-mode-button').disabled = busy;
    $('selected-list').hidden = !listId;
    if (!busy) {
      $('sign-up').disabled = Date.now() < signupBlockedUntil;
      const errors = [];
      let rpc = null, legacy = [];
      try { rpc = user && protocol.read(user.id); }
      catch (error) { errors.push(error.message); }
      try { legacy = user ? legacyReceipts(user.id, errors) : []; }
      catch (error) { errors.push(error.message); }
      const pending = !!(rpc?.state === 'pending' || legacy.length || errors.length);
      $('check-pending').hidden = rpc?.state !== 'pending';
      $('legacy-recovery').hidden = !legacy.length;
      const previous = $('legacy-receipts').value;
      $('legacy-receipts').replaceChildren(...legacy.map(record => {
        const option = document.createElement('option');
        option.value = record.listId; option.textContent = `Legacy ${record.saved.kind}: ${record.listId}`;
        return option;
      }));
      if (legacy.some(record => record.listId === previous)) $('legacy-receipts').value = previous;
      $('recovery-summary').textContent = rpc?.state === 'pending'
        ? `Unconfirmed ${rpc.operation} for ${rpc.listId || 'a new list'}. Resume its original request; do not start a replacement.`
        : legacy.length ? 'Legacy saves require a read-only check. Missing or changed rows need review.' : '';
      if (errors.length) $('recovery-summary').textContent += ` ${errors.join(' ')}`;
      for (const el of $('cloud-form').querySelectorAll('input, button')) el.disabled = !loaded || pending;
      $('cloud-clear').disabled = !loaded || pending || !rows.some(row => row.purchased);
      $('create-list').disabled = pending;
      $('create-invite').disabled = !loaded || pending;
      $('join-form').querySelector('button').disabled = pending;
      $('cloud-submit').disabled = !loaded || pending;
      $('cloud-import').disabled = !loaded || pending;
      for (const el of $('cloud-items').querySelectorAll('button, input')) el.disabled = !loaded || pending;
    }
  }
  async function run(task) {
    if (busy) return;
    busy = true;
    failureVisible = false;
    controls();
    try { await task(); }
    catch (error) {
      failureVisible = true;
      if (error.status === 429 || ['over_email_send_rate_limit', 'over_request_rate_limit'].includes(error.code)) {
        message('Supabase rate limit reached. Wait before trying again; the email quota may take longer to reset. No automatic retry was made.');
      } else if (error.code === 'email_not_confirmed') {
        message('Confirm your email before signing in. Check the latest confirmation email; your local groceries are unchanged.');
      } else message(error.message || 'The request failed. Check your connection; local groceries are unchanged.');
    } finally { busy = false; controls(); }
  }
  function cancelEdit() {
    editing = null;
    $('cloud-name').value = '';
    $('cloud-name').setCustomValidity('');
    $('cloud-quantity').value = '1';
    $('cloud-submit').textContent = 'Add to shared list';
    $('cloud-cancel').hidden = true;
  }
  function stopSync() {
    clearInterval(poll);
    if (channel && client) void client.removeChannel(channel);
    channel = null;
  }
  function resetCloud() {
    epoch++;
    failureVisible = false;
    stopSync();
    user = null;
    listId = null;
    rows = [];
    loaded = false;
    cancelEdit();
    $('cloud-items').replaceChildren();
    $('cloud-lists').replaceChildren();
    $('account-session').hidden = true;
    $('account-form').hidden = false;
    $('signed-in-as').textContent = '';
    $('invitation-result').textContent = '';
    $('invite-code').value = '';
    controls();
  }
  async function getClient() {
    if (client) return client;
    const config = window.GROCERY_SHARED_CONFIG;
    if (!config?.url || !config.publishableKey?.startsWith('sb_publishable_')) {
      throw new Error('Shared configuration is unavailable. Local mode is still available.');
    }
    if (!window.supabase) {
      if (!sdkLoading) sdkLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'vendor/supabase-2.118.0.js';
        script.onload = resolve;
        script.onerror = () => { sdkLoading = null; script.remove(); reject(new Error('Could not load shared mode. Try again.')); };
        document.head.append(script);
      });
      await sdkLoading;
    }
    client = window.supabase.createClient(config.url, config.publishableKey, {
      auth: { storageKey: 'grocery-email-session-v1', detectSessionInUrl: false },
      // Never automatically repeat a write/RPC after an uncertain response.
      db: { retry: false, timeout: 15000 },
    });
    client.auth.onAuthStateChange((event, session) => {
      // Never perform awaited SDK calls from an auth callback.
      if (event === 'SIGNED_OUT' || (user && session?.user?.id !== user.id)) {
        resetCloud();
        if (active) message('Session changed. Sign in again to open your shared lists.');
      }
    });
    return client;
  }
  function normalize(data) {
    return data.map(row => {
      const validId = typeof row.id === 'number'
        ? Number.isSafeInteger(row.id)
        : typeof row.id === 'string' && /^-?\d+$/.test(row.id);
      if (!validId || !uuid.test(row.revision) || typeof row.item_name !== 'string' || !row.item_name.trim() ||
          row.item_name.length > 150 || !Number.isInteger(row.quantity) ||
          row.quantity < 1 || row.quantity > 999 || typeof row.purchased !== 'boolean') {
        throw new Error('The shared list contains an unsupported record. Nothing was discarded; ask for a data review.');
      }
      return { ...row, id: String(row.id) };
    });
  }
  function table() { return client.from('grocery_items'); }
  const fields = 'id,item_name,quantity,purchased,created_at,list_id,revision';
  async function loadRows() {
    const guard = context();
    const version = ++readVersion;
    const data = [];
    for (let offset = 0; ; offset += 500) {
      const result = await table().select(fields).eq('list_id', listId)
        .order('created_at').order('id').range(offset, offset + 499);
      guard();
      const page = check(result);
      if (version !== readVersion) return;
      data.push(...page);
      if (page.length < 500) break;
    }
    rows = normalize(data);
    loaded = true;
    renderRows();
  }
  async function backgroundRefresh() {
    if (!active || !user || !listId || busy || refreshing || !navigator.onLine || document.hidden) return;
    const current = epoch;
    refreshing = true;
    try {
      await loadRows();
      if (current !== epoch) return;
      controls();
      if (!failureVisible) message('Shared list refreshed.');
    } catch (error) {
      if (current !== epoch) return;
      loaded = false; controls();
      if (!failureVisible) message(`Refresh failed: ${error.message}. Refresh before saving.`);
    } finally { refreshing = false; }
  }
  function startSync() {
    stopSync();
    // Refetch authoritative rows instead of applying partial event payloads.
    // Polling catches filtered DELETE limitations and missed/reconnecting events.
    const current = epoch;
    channel = client.channel(`groceries:${listId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'grocery_items', filter: `list_id=eq.${listId}` }, backgroundRefresh)
      .subscribe(status => {
        if (current !== epoch || !active || !listId || busy || failureVisible) return;
        if (status === 'SUBSCRIBED') { message('Connected. Shared changes are synchronized.'); void backgroundRefresh(); }
        if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          message('Live connection interrupted. Connected clients also refresh every five seconds.');
        }
      });
    poll = setInterval(backgroundRefresh, 5000);
  }
  async function selectList(id) {
    epoch++;
    stopSync();
    listId = id || null;
    rows = [];
    loaded = false;
    cancelEdit();
    $('invitation-result').textContent = '';
    renderRows();
    if (!listId) { message(pendingMutation() ? 'Resume the earlier unconfirmed operation before creating a list.' : 'Create a private list or join using an invitation.'); return; }
    localStorage.setItem(`grocery-selected-list:${user.id}`, listId);
    message('Loading shared list…');
    await loadRows();
    startSync();
    message('Shared list loaded. Changes refresh automatically while connected.');
    if (pendingMutation() || legacyReceipts(user.id).length) { failureVisible = true; message('An earlier save is unconfirmed. Check it before adding or importing again.'); }
  }
  async function memberships(preferred) {
    const current = epoch;
    const result = await client.from('grocery_list_members').select('list_id').eq('user_id', user.id).order('created_at');
    if (current !== epoch) return;
    const data = check(result);
    const ids = [...new Set(data.map(row => row.list_id))];
    if (ids.some(id => !uuid.test(id))) throw new Error('Invalid list membership data.');
    $('cloud-lists').replaceChildren(...ids.map(id => {
      const option = document.createElement('option'); option.value = id; option.textContent = id; return option;
    }));
    const remembered = preferred || localStorage.getItem(`grocery-selected-list:${user.id}`);
    const selected = ids.includes(remembered) ? remembered : ids[0];
    $('cloud-lists').value = selected || '';
    await selectList(selected);
  }
  async function identity(session) {
    resetCloud();
    if (!isEmailUser(session)) { message('Sign in with your email account. Anonymous sessions are not used in shared mode.'); return; }
    user = session.user;
    $('account-session').hidden = false;
    $('account-form').hidden = true;
    $('account-password').value = '';
    $('signed-in-as').textContent = `Signed in as ${user.email}`;
    await memberships();
  }
  async function mutate(task, success) {
    if (!loaded || !navigator.onLine) throw new Error('Offline or list not loaded. Refresh before saving.');
    const guard = context();
    message('Saving…');
    await task();
    guard();
    try {
      await loadRows();
      message(success);
    } catch (error) {
      // The write was confirmed. Do not leave a successful add in the form
      // looking unsaved just because its subsequent refresh failed.
      loaded = false;
      message(`${success} Refresh failed: ${error.message}. Refresh before saving again.`);
    }
  }
  function pendingMutation() { return user && protocol.read(user.id)?.state === 'pending'; }
  function confirmedRejection(result, saved) {
    // Require a structured server rejection, not a fetch error or gateway status.
    // Unknown errors (including unavailable/incomplete ledger results and request
    // ID reuse) keep the original intent so recovery cannot issue a fresh write.
    if (!result?.error || result.status < 400 || result.status >= 500 ||
        !Number.isInteger(result.status) || [408, 429].includes(result.status)) return false;
    const { code, message } = result.error;
    if (saved?.operation === 'add_items') {
      // Only these validations run AFTER ledger lookup in the supported 003.
      // Access/capability errors may precede a previously committed result.
      // Collisions, mismatched IDs, unknown SQLSTATEs and transport errors need review.
      return code === 'P0001' && ['Add requires an items array',
        'Add batch must contain 1 to 200 items', 'Invalid add item',
        'Invalid item values', 'Duplicate add item ID'].includes(message);
    }

    if (/^(22|23)[0-9A-Z]{3}$/.test(code || '') || code === '42501') return true;
    return code === 'P0001' && [
      'Authentication required', 'A request ID is required',
      'Access to the previously created list is no longer available',
      'Request ID, list, operation and object payload are required',
      'Unsupported mutation', 'You are not a member of this grocery list',
      'Invite payload must be empty', 'Item ID and revision required',
      'Invalid item values', 'Clear requires frozen targets',
      'Clear target limit exceeded', 'Invalid clear target',
    ].includes(message);
  }
  async function addRpcClient(saved) {
    // Bind dispatch to one verified token; a later SDK session switch must not
    // execute this caller's intent as another member. Tokens stay in memory only.
    const session = check(await client.auth.getSession()).session;
    if (!session?.access_token || session.user.id !== saved.userId) throw new Error('Sign in as the original caller before resuming.');
    const verified = check(await client.auth.getUser(session.access_token)).user;
    if (verified?.id !== saved.userId) throw new Error('The authenticated caller changed. Keep the pending receipt.');
    const config = window.GROCERY_SHARED_CONFIG;
    return window.supabase.createClient(config.url, config.publishableKey, {
      accessToken: async () => session.access_token,
      db: { retry: false, timeout: 15000 },
    });
  }
  async function executeSaved(saved, caller, current) {
    const guard = () => {
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
    };
    let data, rejected = false;
    try {
      const transport = saved.operation === 'add_items' ? await addRpcClient(saved) : client;
      guard();
      const result = await protocol.execute(transport, saved);
      guard();
      if (confirmedRejection(result, saved)) {
        protocol.complete(saved, { status: 'rejected' });
        rejected = true;
      }
      data = check(result);
    } catch (error) {
      if (rejected) throw error;
      throw new Error(`${error.message} Refresh lists before starting another create or join. Resume the unconfirmed operation with its saved request ID; do not create a new request.`);
    }
    if (saved.operation === 'add_items') {
      protocol.validateAddResult(saved, data);
      if (saved.intent.kind === 'import') storeVerified(importKey(caller, saved.listId), saved.intent.source);
    } else {
      if (saved.operation === 'create' ? !uuid.test(data) : !data || !['ok', 'conflict'].includes(data.status)) {
        throw new Error('Unexpected mutation response. Keep the pending receipt and request a review.');
      }
      if (saved.operation === 'invite' && (!uuid.test(data.token) || !data.expires_at)) throw new Error('Unexpected invitation response. Keep the pending receipt.');
      if (saved.operation === 'clear_purchased' && !Array.isArray(data.deleted_ids)) throw new Error('Unexpected clear response. Keep the pending receipt.');
    }
    protocol.complete(saved, data);
    if (saved.operation === 'create') await memberships(data);
    else if (saved.operation !== 'add_items') {
      if (listId !== saved.listId) await memberships(saved.listId);
      if (saved.operation === 'invite') {
        $('invitation-result').textContent = data.token;
        message('Invitation result restored. Share privately; the original invitation may already be used or expired.');
      }
      if (data.status === 'conflict') {
        await loadRows();
        throw new Error('This item changed or was removed on another device. Refresh; cancel and reopen the edit before retrying. Your input is kept.');
      }
    }
    return { saved, data };
  }
  async function protectedRequest(operation, payload, resume = false) {
    if (!user || !navigator.onLine) throw new Error('Sign in and reconnect before saving.');
    const caller = user.id, current = epoch;
    return protocol.exclusive(caller, async () => {
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
      // Existing RPCs can recover even when an unrelated legacy receipt exists.
      if (!resume) { noLegacyPending(caller); repairImportMarker(caller); }
      const saved = resume ? protocol.read(caller) : protocol.prepare(caller, operation === 'create' ? null : listId, operation, payload);
      if (!saved || saved.state !== 'pending') throw new Error('No pending mutation to resume.');
      return executeSaved(saved, caller, current);
    });
  }
  async function conditionalWrite(row, patch) {
    const payload = { id: row.id, revision: row.revision };
    if (patch) Object.assign(payload, { item_name: row.item_name, quantity: row.quantity, purchased: row.purchased }, patch);
    return protectedRequest(patch ? 'edit' : 'delete', payload);
  }
  function renderRows() {
    $('cloud-items').replaceChildren();
    $('cloud-count').textContent = `${rows.filter(row => !row.purchased).length} of ${rows.length} items left to buy`;
    for (const row of rows) {
      const li = document.createElement('li'); li.className = row.purchased ? 'done' : '';
      const purchased = document.createElement('input'); purchased.type = 'checkbox'; purchased.checked = row.purchased;
      purchased.setAttribute('aria-label', `Purchased ${row.item_name}`);
      purchased.addEventListener('change', () => {
        const value = purchased.checked; purchased.checked = row.purchased;
        void run(async () => {
          await mutate(() => conditionalWrite(row, { purchased: value }), 'Purchased state saved.');
          $('cloud-items').querySelector(`[data-item-id="${row.id}"] input`)?.focus();
        });
      });
      const text = document.createElement('span'); text.className = 'item'; text.textContent = `${row.item_name} × ${row.quantity}`;
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'edit'; edit.textContent = 'Edit';
      edit.setAttribute('aria-label', `Edit ${row.item_name}`);
      edit.addEventListener('click', () => {
        editing = { ...row }; $('cloud-name').value = row.item_name; $('cloud-name').setCustomValidity('');
        $('cloud-quantity').value = row.quantity; $('cloud-submit').textContent = 'Save shared changes';
        $('cloud-cancel').hidden = false; $('cloud-name').focus(); $('cloud-name').select();
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove'; remove.textContent = '✕';
      remove.setAttribute('aria-label', `Remove ${row.item_name}`);
      remove.addEventListener('click', () => void run(async () => {
        await mutate(() => conditionalWrite(row), 'Item removed.');
        if (editing?.id === row.id) cancelEdit();
        $('cloud-name').focus();
      }));
      li.dataset.itemId = row.id; li.append(purchased, text, edit, remove); $('cloud-items').append(li);
    }
  }
  function newId() {
    // BY DEFAULT bigint identity permits explicit IDs. Negative safe integers
    // avoid the positive server sequence and survive JavaScript JSON exactly.
    const words = crypto.getRandomValues(new Uint32Array(2));
    return -(1 + (words[0] & 0xfffff) * 4294967296 + words[1]);
  }
  async function reconcileLegacy(target) {
    if (!user || !navigator.onLine) throw new Error('Sign in and reconnect before checking the legacy save.');
    const caller = user.id, current = epoch;
    return protocol.exclusive(caller, async () => {
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
      const saved = receiptAt(caller, target);
      if (!saved || saved.state !== 'pending') return;
      const key = `grocery-save-v1:${caller}:${target}`;
      // SELECT-only, even without 003. Revision/history cannot be reconstructed.
      const result = await table().select('id,list_id,owner_id,item_name,quantity,purchased')
        .eq('list_id', target).in('id', saved.records.map(row => row.id));
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
      const data = check(result);
      const matches = Array.isArray(data) && data.length === saved.records.length &&
        new Set(data.map(row => row && String(row.id))).size === saved.records.length &&
        saved.records.every(record => data.some(row => row &&
          (typeof row.id === 'string' || Number.isSafeInteger(row.id)) && String(row.id) === String(record.id) &&
          row.list_id === target && row.owner_id === caller && row.item_name === record.item_name &&
          row.quantity === record.quantity && row.purchased === record.purchased));
      if (!matches) throw new Error('Legacy save is still unconfirmed: rows are missing, changed, inaccessible or malformed. Nothing was inserted. Keep this receipt and request a data review.');
      if (JSON.stringify(receiptAt(caller, target)) !== JSON.stringify(saved)) throw new Error('Legacy receipt changed. Stop and request a review.');
      if (saved.kind === 'import') storeVerified(importKey(caller, target), saved.source);
      storeVerified(key, JSON.stringify({ ...saved, state: 'confirmed' }));
      message(`Legacy save for ${target} matched existing rows. No groceries were inserted; local groceries are unchanged.`);
    });
  }
  async function addBatch(entries, kind, source) {
    if (!user || !navigator.onLine || !listId || !loaded) throw new Error('Sign in and refresh the list before saving.');
    const caller = user.id, target = listId, current = epoch;
    return protocol.exclusive(caller, async () => {
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
      if (pendingMutation()) throw new Error('Resume the earlier unconfirmed operation first.');
      noLegacyPending(caller);
      repairImportMarker(caller);
      const previous = receiptAt(caller, target);
      if (kind === 'import' && (localStorage.getItem(importKey(caller, target)) === source ||
          (previous?.state === 'confirmed' && previous.kind === 'import' && previous.source === source))) {
        throw new Error('This local snapshot was already imported. Local groceries are still available.');
      }
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > 200) throw new Error('Add/import requires 1–200 groceries. Nothing was sent.');
      const ids = new Set();
      const items = entries.map(entry => {
        let id;
        // A duplicate is regenerated only BEFORE persistence, never after send.
        for (let attempt = 0; attempt < 10; attempt++) { id = newId(); if (!ids.has(id)) break; }
        if (ids.has(id)) throw new Error('Could not generate unique item IDs. Nothing was sent.');
        ids.add(id);
        return { id, item_name: entry.name, quantity: entry.quantity, purchased: kind === 'import' ? entry.done : false };
      });
      const intent = kind === 'import' ? { kind, source } : { kind };
      const saved = protocol.prepare(caller, target, 'add_items', { items }, intent);
      return executeSaved(saved, caller, current);
    });
  }
  $('shared-mode-button').addEventListener('click', () => void run(async () => {
    active = true; $('shared-mode').hidden = false; $('local-mode').hidden = true;
    $('shared-mode-button').setAttribute('aria-pressed', 'true'); $('local-mode-button').setAttribute('aria-pressed', 'false');
    message('Restoring account…');
    await getClient();
    const data = check(await client.auth.getSession());
    await identity(data.session);
  }));
  $('local-mode-button').addEventListener('click', () => {
    active = false; resetCloud(); $('shared-mode').hidden = true; $('local-mode').hidden = false;
    $('shared-mode-button').setAttribute('aria-pressed', 'false'); $('local-mode-button').setAttribute('aria-pressed', 'true');
  });
  $('account-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      await getClient(); message('Signing in…');
      const data = check(await client.auth.signInWithPassword({ email: $('account-email').value.trim(), password: $('account-password').value }));
      await identity(data.session);
    });
  });
  $('sign-up').addEventListener('click', () => {
    if (!$('account-form').reportValidity() || Date.now() < signupBlockedUntil) return;
    void run(async () => {
      signupBlockedUntil = Date.now() + 60000;
      setTimeout(controls, 60000);
      await getClient();
      const data = check(await client.auth.signUp({ email: $('account-email').value.trim(), password: $('account-password').value }));
      $('account-password').value = '';
      if (data.session) await identity(data.session);
      else message('Check your email if a new signup was accepted, then return here to sign in. Existing users should sign in instead. Email delivery may be rate limited.');
    });
  });
  $('sign-out').addEventListener('click', () => void run(async () => {
    check(await client.auth.signOut({ scope: 'local' })); resetCloud(); message('Signed out. Local groceries are unchanged.');
  }));
  $('cloud-lists').addEventListener('change', () => void run(() => selectList($('cloud-lists').value)));
  $('refresh-lists').addEventListener('click', () => void run(() => memberships(listId)));
  $('create-list').addEventListener('click', () => void run(async () => {
    if (!navigator.onLine) throw new Error('Offline. Reconnect before creating a list.');
    message('Creating list…');
    await protectedRequest('create', {});
  }));
  $('join-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      if (pendingMutation()) throw new Error('Resume the earlier unconfirmed operation first.');
      noLegacyPending(user.id); repairImportMarker(user.id);
      const token = $('invite-code').value.trim();
      if (!uuid.test(token)) throw new Error('Enter a valid invitation code.');
      let id;
      try { id = check(await client.rpc('redeem_grocery_list_invite', { invite_token: token })); }
      catch (error) { throw new Error(`${error.message} Refresh lists before retrying; if a response was lost, joining may already have succeeded.`); }
      if (!uuid.test(id)) throw new Error('Unexpected join response. Refresh lists before trying again.');
      $('invite-code').value = ''; await memberships(id);
    });
  });
  $('create-invite').addEventListener('click', () => void run(() => protectedRequest('invite', {})));
  $('cloud-name').addEventListener('input', () => $('cloud-name').setCustomValidity(''));
  $('cloud-cancel').addEventListener('click', () => { cancelEdit(); $('cloud-name').focus(); });
  $('cloud-form').addEventListener('submit', event => {
    event.preventDefault();
    void run(async () => {
      const name = $('cloud-name').value.trim(); const quantity = Number($('cloud-quantity').value);
      if (!name || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return;
      let entries;
      try { entries = editing ? null : parseGroceryList(name, quantity); }
      catch (error) { $('cloud-name').setCustomValidity(error.message); $('cloud-name').reportValidity(); return; }
      await mutate(() => editing ? conditionalWrite(editing, { item_name: name, quantity }) : addBatch(entries, 'add'), 'Shared changes saved.');
      cancelEdit(); $('cloud-name').focus();
    });
  });
  $('cloud-clear').addEventListener('click', () => {
    const targets = rows.filter(row => row.purchased).map(row => ({ id: row.id, revision: row.revision }));
    void run(async () => {
      let removed = 0;
      await mutate(async () => {
        const { data } = await protectedRequest('clear_purchased', { targets });
        removed = data.deleted_ids.length;
      }, 'Purchased items cleared from the shared list.');
      if (removed < targets.length) message(`Cleared ${removed} items; ${targets.length - removed} changed or missing items were skipped. Review the refreshed list.`);
      if (editing && !rows.some(row => row.id === editing.id)) cancelEdit();
    });
  });
  $('cloud-refresh').addEventListener('click', () => void run(async () => {
    await loadRows(); message('Shared list refreshed.');
  }));
  $('cloud-import').addEventListener('click', () => void run(async () => {
    const source = localStorage.getItem('my-groceries-v1') || '[]';
    const entries = JSON.parse(source);
    if (!Array.isArray(entries) || entries.some(row => !row || typeof row.name !== 'string' || !row.name.trim() ||
        row.name.length > 150 || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 999 || typeof row.done !== 'boolean')) {
      throw new Error('Local data needs review before importing. Nothing was changed.');
    }
    if (!entries.length) throw new Error('There are no local groceries to import.');
    const previous = receipt();
    // Import confirmation is separately retained: later ordinary adds must not
    // erase proof that this local snapshot was already imported.
    const markerKey = importKey(user.id, listId);
    if (localStorage.getItem(markerKey) === source || (previous?.kind === 'import' && previous.source === source && previous.state === 'confirmed')) {
      throw new Error('This local snapshot was already imported. Local groceries are still available.');
    }
    if (!window.confirm(`Copy ${entries.length} local groceries into this shared list? The local copy will be kept.`)) return;
    await mutate(async () => {
      await addBatch(entries, 'import', source);
    }, 'Local groceries imported successfully. The original local copy is unchanged.');
  }));
  $('check-pending').addEventListener('click', () => void run(async () => {
    const { saved } = await protectedRequest(null, null, true);
    if (saved.operation === 'add_items') {
      // Confirmation is durable before any refresh; never treat a failed read as
      // an unsaved add. Do not clear another list's current form.
      message(`Earlier ${saved.intent.kind} for ${saved.listId} confirmed. Local groceries are unchanged.`);
      if (listId === saved.listId) {
        cancelEdit();
        try { await loadRows(); }
        catch (error) { loaded = false; message(`Earlier save confirmed. Refresh failed: ${error.message}`); }
      }
    } else if (saved.operation !== 'create' && saved.operation !== 'invite') {
      await loadRows(); cancelEdit();
      const outcome = saved.operation === 'clear_purchased' ? ` Deleted ${protocol.read(user.id).result.deleted_ids.length} of ${saved.payload.targets.length} captured targets; changed or missing targets were skipped.` : '';
      message(`Earlier operation confirmed.${outcome} Current shared records refreshed; local groceries are unchanged.`);
    }
  }));
  $('check-legacy').addEventListener('click', () => void run(() => reconcileLegacy($('legacy-receipts').value)));
  window.addEventListener('storage', event => {
    if (user && (event.key === null || event.key === `grocery-mutation-v1:${user.id}` ||
        event.key?.startsWith(`grocery-save-v1:${user.id}:`) || event.key?.startsWith(`grocery-imported-v1:${user.id}:`))) controls();
  });
  window.addEventListener('offline', () => {
    if (active) { loaded = false; controls(); message('Offline. Shared saves are disabled; your local list is available.'); }
  });
  window.addEventListener('online', backgroundRefresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void backgroundRefresh(); });
})();
