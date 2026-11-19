import { ref, computed, watch, onMounted, onUnmounted } from 'vue';

function normalizeSyncReceiptVersion(version) {
  // Earlier receipts also included online and syncStatus. Preserve those
  // acknowledgements when upgrading to the stable incident version.
  const fields = version.split(':');
  if (fields.length !== 4 || !/^\d+$/.test(fields[0]) ||
    !['', 'true', 'false'].includes(fields[1]) || !['', 'true', 'false'].includes(fields[2])) return version;
  return [fields[0], fields[2] === 'true'].join(':');
}

// Reminders use the data already held by the app. Only local receipts are stored;
// no server client or polling lifecycle participates in this module.
export function useNotices({ state, systemItems, ledgerReady = ref(true) }) {
  const receipts = ref({});
  const scope = computed(() => JSON.stringify([state.value.serverUrl || 'local',
    state.value.binding?.storeId || state.value.user?.storeId || 'local', state.value.user?.id || 'device']));
  const storageKey = () => 'member_notice_receipts_v1:' + scope.value;
  function readReceipts() {
    try {
      const data = JSON.parse(localStorage.getItem(storageKey()) || '{}');
      receipts.value = data && typeof data === 'object' && !Array.isArray(data)
        ? Object.fromEntries(Object.entries(data).filter(([id, receipt]) => id.startsWith('system:') &&
          receipt && typeof receipt.version === 'string' && typeof receipt.acknowledged === 'boolean' && typeof receipt.deleted === 'boolean')
          .map(([id, receipt]) => [id, id === 'system:sync' ? { ...receipt, version: normalizeSyncReceiptVersion(receipt.version) } : receipt])) : {};
    } catch { receipts.value = {}; }
  }
  const items = computed(() => systemItems.value.map(item => {
    const receipt = receipts.value[item.id];
    const matches = receipt?.version === item.version;
    return { ...item, acknowledged: Boolean(!item.required && matches && receipt.acknowledged),
      deleted: Boolean(!item.required && matches && receipt.deleted) };
  }).filter(item => !item.deleted).sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required))
    || Number(a.acknowledged) - Number(b.acknowledged)));
  const pending = computed(() => items.value.filter(item => !item.acknowledged));
  const headerItems = computed(() => pending.value.filter(item => item.showInHeader));
  function reconcileReceipts() {
    const current = new Map(systemItems.value.map(item => [item.id, item]));
    const next = { ...receipts.value }; let changed = false;
    for (const [id, receipt] of Object.entries(next)) {
      // An empty projection during login is not evidence that a debt was paid.
      if (id === 'system:debt' && !ledgerReady.value) continue;
      const item = current.get(id);
      // Reconcile persisted incidents against a loaded ledger, including on
      // restart. A retry in progress does not resolve a connection incident.
      const resolved = !item && (id === 'system:debt' || id === 'system:sync' && state.value.syncStatus === 'confirmed');
      if (resolved || item && item.version !== receipt.version) { delete next[id]; changed = true; }
    }
    if (changed) {
      receipts.value = next;
      try { localStorage.setItem(storageKey(), JSON.stringify(next)); } catch { /* Current reminders remain visible. */ }
    }
  }

  function act(item, action) {
    const current = items.value.find(row => row.id === item.id && row.version === item.version);
    if (state.value.locked || state.value.deviceAccess?.allowed === false || !current || current.required ||
      !['acknowledge', 'delete'].includes(action) ||
      action === 'acknowledge' && !current.buttonLabel || action === 'delete' && !current.allowDelete) return false;
    const next = { ...receipts.value, [current.id]: { version: current.version, acknowledged: true, deleted: action === 'delete' } };
    // Persist before hiding anything so failed writes can be reported honestly.
    localStorage.setItem(storageKey(), JSON.stringify(next)); receipts.value = next;
    return true;
  }
  watch(scope, readReceipts, { immediate: true, flush: 'sync' });
  watch([scope, systemItems, ledgerReady], reconcileReceipts, { immediate: true });
  const storageChanged = event => {
    if (!event.key || event.key === storageKey()) { readReceipts(); reconcileReceipts(); }
  };
  onMounted(() => window.addEventListener('storage', storageChanged));
  onUnmounted(() => window.removeEventListener('storage', storageChanged));
  return { scope, items, pending, headerItems, act };
}
