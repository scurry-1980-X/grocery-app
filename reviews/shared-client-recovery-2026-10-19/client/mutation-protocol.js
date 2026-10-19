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
    if (!raw) return null;
    let saved;
    try { saved = JSON.parse(raw); } catch { /* fail closed */ }
    if (!saved || saved.userId !== userId || !uuid.test(saved.requestId) ||
        !['pending', 'confirmed'].includes(saved.state) ||
        !['create', 'invite', 'edit', 'delete', 'clear_purchased'].includes(saved.operation) ||
        (saved.operation === 'create' ? saved.listId !== null : !uuid.test(saved.listId)) ||
        !saved.payload || typeof saved.payload !== 'object' || Array.isArray(saved.payload)) {
      throw new Error('Saved mutation receipt needs review. Nothing new was sent.');
    }
    return saved;
  }
  function prepare(userId, listId, operation, payload) {
    if (read(userId)?.state === 'pending') throw new Error('Resume the earlier unconfirmed operation before making another change.');
    const saved = { userId, listId, operation, payload, requestId: requestId(), state: 'pending' };
    localStorage.setItem(key(userId), JSON.stringify(saved));
    return read(userId);
  }
  function complete(saved, result) {
    // Never persist invitation tokens. The server ledger can return the token
    // again if confirmation storage fails. Auth tokens never enter this module.
    const summary = saved.operation === 'invite' ? { status: result.status, expires_at: result.expires_at } : result;
    localStorage.setItem(key(saved.userId), JSON.stringify({ ...saved, state: 'confirmed', result: summary }));
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
  window.GroceryMutation = Object.freeze({ read, prepare, complete, execute, exclusive, requestId });
})();
