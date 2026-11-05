let accessCheck = null;
let version = 0;

export function configureLedgerAccess(check) { accessCheck = check; version++; }
export function ledgerAccessVersion() { return version; }
export function assertLedgerAccess(expectedVersion = version) {
  if (expectedVersion !== version || accessCheck && !accessCheck()) {
    throw Object.assign(new Error('账本已由其他页面接管，请等待本页重新加载'), { code: 'LEDGER_BUSY' });
  }
}

// Hold the browser lock for the entire mounted page, including synchronous
// reads and crash recovery. Reacquire after returning from the back/forward cache.
export function createLedgerPage({ locks = globalThis.navigator?.locks, eventTarget = globalThis.window,
  onAcquire, onRelease = () => {}, onWaiting = () => {}, onError = () => {} }) {
  let current = null, disposed = false, allowed = false;
  const page = {
    hasAccess: () => allowed,
    start() {
      if (disposed || current) return;
      onWaiting();
      if (!locks?.request) { onError(new Error('当前浏览器无法安全打开账本，请使用新版 Chrome、Edge、Firefox 或 Safari')); return; }
      const controller = new AbortController(), ticket = { controller, release: null };
      current = ticket;
      locks.request('hairstudio-mobile-ledger', { signal: controller.signal }, async () => {
        if (current !== ticket || disposed) return;
        allowed = true;
        const held = new Promise(resolve => { ticket.release = resolve; });
        let failure;
        try { onAcquire(); await held; }
        catch (error) { failure = error; }
        finally { if (current === ticket) { allowed = false; onRelease(); current = null; } }
        if (failure) onError(failure);
      }).catch(error => {
        if (current === ticket) { current = null; allowed = false; if (error.name !== 'AbortError') onError(error); }
      });
    },
    suspend() {
      const ticket = current;
      if (!ticket) return;
      allowed = false;
      onRelease();
      current = null;
      if (ticket.release) ticket.release(); else ticket.controller.abort();
    },
    dispose() {
      disposed = true; this.suspend();
      eventTarget?.removeEventListener('pagehide', hide);
      eventTarget?.removeEventListener('pageshow', show);
    }
  };
  const hide = () => page.suspend(), show = () => page.start();
  eventTarget?.addEventListener('pagehide', hide);
  eventTarget?.addEventListener('pageshow', show);
  return page;
}
