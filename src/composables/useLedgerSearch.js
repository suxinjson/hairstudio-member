import { ref, computed, watch } from 'vue';

export function useLedgerSearch({
  activeTab,
  ledgersList,
  membersList,
  storageError,
  localDb,
  refreshAll,
  refreshLedgers,
  getTypeText
}) {
  const searchQuery = ref('');
  const ledgerSearchQuery = ref('');
  const ledgerFilterType = ref('');

  const headerSearchQuery = computed({
    get: () => (activeTab.value === 'ledgers' ? ledgerSearchQuery.value : searchQuery.value),
    set: (value) => {
      if (activeTab.value === 'ledgers') ledgerSearchQuery.value = value;
      else searchQuery.value = value;
    }
  });

  const searchPlaceholder = computed(() =>
    activeTab.value === 'ledgers' ? '搜索姓名、手机号、服务项目或备注…' : '姓名 / 手机号 / 手机尾号'
  );

  const filteredLedgersList = computed(() => {
    const query = ledgerSearchQuery.value.trim().toLocaleLowerCase();
    if (!query) return ledgersList.value;
    const digits = query.replace(/\D/g, '');
    const typeAliases = {
      RECHARGE: '充值 储值 储值入账 入账',
      CONSUME: '扣款 剪发 剪发扣款 剪发扣费 消费',
      REFUND: '冲正 撤单 撤销 退还 退款'
    };
    return ledgersList.value.filter((item) => {
      const memberName = (item.memberName || '').toLocaleLowerCase();
      const phone = (item.memberPhone || '').replace(/\D/g, '');
      const remark = (item.remark || '').toLocaleLowerCase();
      const typeLabel = (getTypeText(item.type) || '').toLocaleLowerCase();
      const aliases = typeAliases[item.type] || '';
      return (
        memberName.includes(query) ||
        (digits && phone.includes(digits)) ||
        remark.includes(query) ||
        typeLabel.includes(query) ||
        aliases.includes(query)
      );
    });
  });

  function handleSearch(event) {
    if (storageError.value || event?.target?.composing) return;
    if (event?.target && typeof event.target.value === 'string' && headerSearchQuery.value !== event.target.value) {
      headerSearchQuery.value = event.target.value;
      return;
    }
    try {
      if (activeTab.value === 'ledgers') refreshLedgers();
      else membersList.value = localDb.getMembers(searchQuery.value);
    } catch {
      refreshAll();
    }
  }

  function clearSearch() {
    if (activeTab.value === 'ledgers') {
      ledgerSearchQuery.value = '';
    } else {
      searchQuery.value = '';
      membersList.value = localDb.getMembers();
    }
  }

  watch(headerSearchQuery, handleSearch, { flush: 'sync' });

  return {
    searchQuery,
    ledgerSearchQuery,
    ledgerFilterType,
    headerSearchQuery,
    searchPlaceholder,
    filteredLedgersList,
    handleSearch,
    clearSearch
  };
}
