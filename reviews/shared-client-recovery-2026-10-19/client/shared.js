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
  const receiptKey = () => `grocery-save-v1:${user.id}:${listId}`;
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
  function receipt() {
    const value = localStorage.getItem(receiptKey());
    if (!value) return null;
    let saved;
    try { saved = JSON.parse(value); } catch { /* handled as unsafe below */ }
    if (!saved || !['pending', 'confirmed'].includes(saved.state) || !['add', 'import'].includes(saved.kind) ||
        (saved.kind === 'import' && typeof saved.source !== 'string') || !Array.isArray(saved.records) ||
        !saved.records.length || saved.records.length > 200 || saved.records.some(row =>
          !row || !Number.isSafeInteger(row.id) || row.id >= 0 || row.list_id !== listId || row.owner_id !== user.id ||
          typeof row.item_name !== 'string' || !row.item_name.trim() || row.item_name.length > 150 ||
          !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 999 || typeof row.purchased !== 'boolean') ||
        new Set(saved.records.map(row => row.id)).size !== saved.records.length) {
      throw new Error('Saved receipt needs review. Nothing was sent or removed. Keep the local copy and request a data review.');
    }
    return saved;
  }
  function controls() {
    for (const el of $('shared-mode').querySelectorAll('button, input, select')) el.disabled = busy;
    $('local-mode-button').disabled = busy;
    $('shared-mode-button').disabled = busy;
    $('selected-list').hidden = !listId;
    if (!busy) {
      $('sign-up').disabled = Date.now() < signupBlockedUntil;
      let pending = false;
      try { pending = !!(user && (protocol.read(user.id)?.state === 'pending' || (listId && receipt()?.state === 'pending'))); }
      catch { pending = true; }
      for (const el of $('cloud-form').querySelectorAll('input, button')) el.disabled = !loaded || pending;
      $('cloud-clear').disabled = !loaded || pending || !rows.some(row => row.purchased);
      $('check-pending').hidden = !pending;
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
    if (protocol.read(user.id)?.state === 'pending' || receipt()?.state === 'pending') { failureVisible = true; message('An earlier save is unconfirmed. Check it before adding or importing again.'); }
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
  function confirmedRejection(result) {
    // Require a structured server rejection, not a fetch error or gateway status.
    // Unknown errors (including unavailable/incomplete ledger results and request
    // ID reuse) keep the original intent so recovery cannot issue a fresh write.
    if (!result?.error || result.status < 400 || result.status >= 500 ||
        !Number.isInteger(result.status) || [408, 429].includes(result.status)) return false;
    const { code, message } = result.error;
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
  async function protectedRequest(operation, payload, resume = false) {
    if (!user || !navigator.onLine) throw new Error('Sign in and reconnect before saving.');
    const caller = user.id, current = epoch;
    return protocol.exclusive(caller, async () => {
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
      if (listId && receipt()?.state === 'pending') throw new Error('Check the earlier unconfirmed save first.');
      const saved = resume ? protocol.read(caller) : protocol.prepare(caller, operation === 'create' ? null : listId, operation, payload);
      if (!saved || saved.state !== 'pending') throw new Error('No pending mutation to resume.');
      let data, rejected = false;
      try {
        const result = await protocol.execute(client, saved);
        if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
        if (confirmedRejection(result)) {
          // Confirm the rejection, not a successful mutation. Reuse the existing
          // receipt format to release the pending gate without losing its ID.
          // Persist before check(), which may reset the signed-in account.
          protocol.complete(saved, { status: 'rejected' });
          rejected = true;
        }
        data = check(result);
      } catch (error) {
        if (rejected) throw error;
        throw new Error(`${error.message} Refresh lists before starting another create or join. Resume the unconfirmed operation with its saved request ID; do not create a new request.`);
      }
      if (saved.operation === 'create' ? !uuid.test(data) : !data || !['ok', 'conflict'].includes(data.status)) {
        throw new Error('Unexpected mutation response. Keep the pending receipt and request a review.');
      }
      if (saved.operation === 'invite' && (!uuid.test(data.token) || !data.expires_at)) throw new Error('Unexpected invitation response. Keep the pending receipt.');
      if (saved.operation === 'clear_purchased' && !Array.isArray(data.deleted_ids)) throw new Error('Unexpected clear response. Keep the pending receipt.');
      protocol.complete(saved, data);
      if (saved.operation === 'create') await memberships(data);
      else {
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
  async function finishReceipt(saved) {
    const guard = context();
    const key = receiptKey();
    const result = await table().select(fields).eq('list_id', listId).in('id', saved.records.map(row => row.id));
    guard();
    const data = check(result);
    if (data.length !== saved.records.length) {
      throw new Error('Save is still unconfirmed. Do not repeat the import or add: it may already have completed. Check again or request a data review.');
    }
    // A matching ID with different content is not silently accepted.
    if (saved.records.some(record => !data.some(row => String(row.id) === String(record.id) &&
        row.item_name === record.item_name && row.quantity === record.quantity && row.purchased === record.purchased))) {
      throw new Error('Saved records differ from this receipt. Another device may have edited them. Request a data review before repeating the save.');
    }
    if (saved.kind === 'import') localStorage.setItem(`grocery-imported-v1:${user.id}:${listId}`, saved.source);
    saved.state = 'confirmed';
    localStorage.setItem(key, JSON.stringify(saved));
  }
  async function insertBatch(entries, kind, source) {
    const caller = user.id, current = epoch;
    return protocol.exclusive(caller, async () => {
      if (current !== epoch || user?.id !== caller) throw new Error('The account or list changed.');
      if (pendingMutation()) throw new Error('Resume the earlier unconfirmed operation first.');
      return insertBatchLocked(entries, kind, source);
    });
  }
  async function insertBatchLocked(entries, kind, source) {
    if (receipt()?.state === 'pending') throw new Error('Check the earlier unconfirmed save first.');
    if (entries.length > 200) throw new Error('Import supports up to 200 local groceries at once. Your local data is unchanged; request a larger-list import plan.');
    const guard = context();
    const key = receiptKey();
    const records = entries.map(entry => ({ id: newId(), item_name: entry.name, quantity: entry.quantity,
      purchased: entry.done || false, list_id: listId, owner_id: user.id }));
    const saved = { state: 'pending', kind, source, records };
    // Persist before any request. If storage fails, nothing is sent.
    localStorage.setItem(key, JSON.stringify(saved));
    const result = await table().insert(records);
    guard();
    if (result.error) {
      // A PostgreSQL rejection is definite. Transport failures remain pending.
      if (/^[0-9A-Z]{5}$/.test(result.error.code || '') && result.error.code !== '23505') localStorage.removeItem(key);
      throw new Error(`${result.error.message}. Input and local groceries were kept. Check unconfirmed saves before retrying.`);
    }
    await finishReceipt(saved);
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
      await mutate(() => editing ? conditionalWrite(editing, { item_name: name, quantity }) : insertBatch(entries, 'add'), 'Shared changes saved.');
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
    const importKey = `grocery-imported-v1:${user.id}:${listId}`;
    if (localStorage.getItem(importKey) === source || (previous?.kind === 'import' && previous.source === source && previous.state === 'confirmed')) {
      throw new Error('This local snapshot was already imported. Local groceries are still available.');
    }
    if (!window.confirm(`Copy ${entries.length} local groceries into this shared list? The local copy will be kept.`)) return;
    await mutate(async () => {
      await insertBatch(entries, 'import', source);
      localStorage.setItem(importKey, source);
    }, 'Local groceries imported successfully. The original local copy is unchanged.');
  }));
  $('check-pending').addEventListener('click', () => void run(async () => {
    if (pendingMutation()) {
      const { saved } = await protectedRequest(null, null, true);
      if (saved.operation !== 'create' && saved.operation !== 'invite') {
        await loadRows(); cancelEdit();
        const outcome = saved.operation === 'clear_purchased' ? ` Deleted ${protocol.read(user.id).result.deleted_ids.length} of ${saved.payload.targets.length} captured targets; changed or missing targets were skipped.` : '';
        message(`Earlier operation confirmed.${outcome} Current shared records refreshed; local groceries are unchanged.`);
      }
      return;
    }
    const saved = receipt();
    if (!saved || saved.state !== 'pending') return;
    await finishReceipt(saved);
    if (saved.kind === 'import') localStorage.setItem(`grocery-imported-v1:${user.id}:${listId}`, saved.source);
    await loadRows(); cancelEdit(); message('Earlier save confirmed. Local groceries are unchanged.');
  }));
  window.addEventListener('storage', event => {
    if (user && event.key === `grocery-mutation-v1:${user.id}`) controls();
  });
  window.addEventListener('offline', () => {
    if (active) { loaded = false; controls(); message('Offline. Shared saves are disabled; your local list is available.'); }
  });
  window.addEventListener('online', backgroundRefresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void backgroundRefresh(); });
})();
