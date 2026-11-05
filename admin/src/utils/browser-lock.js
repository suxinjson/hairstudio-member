const queues = new Map();

// Web Locks serialize tabs. IndexedDB provides an atomic lease on browsers without Web Locks.
export async function withBrowserLock(name, callback, { locks = globalThis.navigator?.locks, indexedDB = globalThis.indexedDB } = {}) {
  if (locks?.request) return locks.request(name, () => callback());
  if (!indexedDB) {
    if (globalThis.window) throw new Error('浏览器无法建立安全同步锁，请使用支持 Web Locks 或 IndexedDB 的浏览器');
    const previous = queues.get(name) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    queues.set(name, next);
    await previous;
    try { return await callback(); }
    finally { release(); if (queues.get(name) === next) queues.delete(name); }
  }
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('hairstudio-admin-locks', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('leases');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法建立浏览器同步锁'));
  });
  const owner = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const controller = new AbortController();
  const lease = (action) => new Promise((resolve, reject) => {
    let acquired = false;
    const transaction = database.transaction('leases', 'readwrite');
    const store = transaction.objectStore('leases'), request = store.get(name);
    request.onsuccess = () => {
      const current = request.result;
      if (action === 'release') { if (current?.owner === owner) store.delete(name); }
      else if (current?.owner === owner || (!current || current.until < Date.now()) && action === 'claim') {
        store.put({ owner, until: Date.now() + 120000 }, name); acquired = true;
      }
    };
    transaction.oncomplete = () => resolve(acquired);
    transaction.onabort = transaction.onerror = () => reject(new Error('浏览器同步锁写入失败'));
  });
  let heartbeat;
  try {
    const deadline = Date.now() + 125000;
    while (!await lease('claim')) {
      if (Date.now() > deadline) throw new Error('其他窗口正在同步，请稍后重试');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    heartbeat = setInterval(() => lease('renew').then(acquired => { if (!acquired) controller.abort(); }).catch(() => controller.abort()), 10000);
    return await callback(controller.signal);
  } finally {
    clearInterval(heartbeat);
    try { await lease('release'); } finally { database.close(); }
  }
}
