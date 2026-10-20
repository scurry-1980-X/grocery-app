/* Durable, caller-scoped RPC intents. Contains no authentication credentials. */
(() => {
  'use strict';
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const key = userId => `grocery-mutation-v1:${userId}`;
  function requestId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map(v => v.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function read(userId) {
    const raw = localStorage.getItem(key(userId));
    if (raw === null) return null;
    let saved;
    try { saved = JSON.parse(raw); } catch { /* fail closed */ }
    if (!saved || saved.userId !== userId || !uuid.test(saved.requestId) ||
        !['pending', 'confirmed'].includes(saved.state) ||
        !['create', 'invite', 'edit', 'delete', 'clear_purchased', 'add_items'].includes(saved.operation) ||
        (saved.operation === 'create' ? saved.listId !== null : !uuid.test(saved.listId)) ||
        !saved.payload || typeof saved.payload !== 'object' || Array.isArray(saved.payload)) {
      throw new Error('Saved mutation receipt needs review. Nothing new was sent.');
    }
    if (saved.operation === 'add_items') {
      validateAddPayload(saved.payload);
      validateIntent(saved.intent, saved.payload);
      if (saved.state === 'confirmed' && saved.result?.status !== 'rejected') validateAddResult(saved, saved.result);
    }
    return saved;
  }
  function exactKeys(value, keys) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  }
  function validateAddPayload(payload) {
    if (!exactKeys(payload, ['items']) || !Array.isArray(payload.items) ||
        !payload.items.length || payload.items.length > 200 || payload.items.some(row =>
          !exactKeys(row, ['id', 'item_name', 'quantity', 'purchased']) ||
          !Number.isSafeInteger(row.id) || row.id >= 0 ||
          typeof row.item_name !== 'string' || !row.item_name.trim() || row.item_name.length > 150 ||
          !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 999 ||
          typeof row.purchased !== 'boolean') ||
        new Set(payload.items.map(row => row.id)).size !== payload.items.length) {
      throw new Error('Invalid add items. Use 1–200 unique negative safe IDs, valid names and quantities. Nothing was sent.');
    }
  }
  function validateIntent(intent, payload) {
    if (exactKeys(intent, ['kind']) && intent.kind === 'add') return;
    if (exactKeys(intent, ['kind', 'source']) && intent.kind === 'import' && typeof intent.source === 'string') {
      let entries;
      try { entries = JSON.parse(intent.source); } catch { /* fail closed */ }
      if (Array.isArray(entries) && entries.length === payload.items.length && entries.every((entry, i) =>
          entry && entry.name === payload.items[i].item_name && entry.quantity === payload.items[i].quantity &&
          entry.done === payload.items[i].purchased)) return;
    }
    throw new Error('Saved add/import intent needs review. Nothing new was sent.');
  }
  function validateAddResult(saved, result) {
    if (!result || result.status !== 'ok' || !Array.isArray(result.items) ||
        result.items.length !== saved.payload.items.length || result.items.some((row, i) => {
          const expected = saved.payload.items[i];
          return !row || row.id !== String(expected.id) || row.list_id !== saved.listId ||
            row.owner_id !== saved.userId || row.item_name !== expected.item_name ||
            row.quantity !== expected.quantity || row.purchased !== expected.purchased ||
            typeof row.revision !== 'string' || !uuid.test(row.revision) ||
            typeof row.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at));
        })) throw new Error('Unexpected add result. Keep the pending receipt and request a review.');
    return result;
  }
  function write(userId, saved) {
    const encoded = JSON.stringify(saved);
    localStorage.setItem(key(userId), encoded);
    if (localStorage.getItem(key(userId)) !== encoded) throw new Error('Mutation receipt could not be verified. Stop and review browser storage.');
  }
  function prepare(userId, listId, operation, payload, intent) {
    if (!uuid.test(userId) || (operation === 'create' ? listId !== null : !uuid.test(listId)) ||
        !['create', 'invite', 'edit', 'delete', 'clear_purchased', 'add_items'].includes(operation)) {
      throw new Error('Invalid mutation identity or operation. Nothing was sent.');
    }
    if (read(userId)?.state === 'pending') throw new Error('Resume the earlier unconfirmed operation before making another change.');
    if (operation === 'add_items') { validateAddPayload(payload); validateIntent(intent, payload); }
    const saved = { userId, listId, operation, payload, requestId: requestId(), state: 'pending' };
    if (operation === 'add_items') saved.intent = intent;
    write(userId, saved);
    return read(userId);
  }
  function complete(saved, result) {
    const current = read(saved.userId);
    if (!current || current.state !== 'pending' || JSON.stringify(current) !== JSON.stringify(saved)) {
      throw new Error('Mutation receipt changed. Keep existing recovery data and request a review.');
    }
    if (saved.operation === 'add_items' && result?.status !== 'rejected') validateAddResult(saved, result);
    // Never persist invitation tokens. The server ledger can return the token
    // again if confirmation storage fails. Auth tokens never enter this module.
    const summary = saved.operation === 'invite' ? { status: result.status, expires_at: result.expires_at } : result;
    write(saved.userId, { ...saved, state: 'confirmed', result: summary });
  }
  async function execute(client, saved) {
    return saved.operation === 'create'
      ? client.rpc('create_grocery_list_once', { request_id: saved.requestId })
      : client.rpc('mutate_grocery_once', { request_id: saved.requestId, target_list_id: saved.listId,
        operation: saved.operation, payload: saved.payload });
  }
  async function exclusive(userId, task) {
    if (!navigator.locks) throw new Error('This browser cannot safely coordinate shared writes. Use a current browser in a secure context. Local groceries are unchanged.');
    return navigator.locks.request(`grocery-write:${userId}`, task);
  }
  window.GroceryMutation = Object.freeze({ read, prepare, complete, execute, exclusive, requestId, validateAddPayload, validateAddResult });
})();
