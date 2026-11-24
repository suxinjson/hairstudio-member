<template>
  <main class="book-stack pb-24 max-w-full overflow-x-hidden" :key="bookKey">
    <RelationalPending v-if="workspace.state.book" :workspace="workspace" />
    <slot name="connection" />

    <div v-if="active !== 'settings' && !workspace.state.book" class="book-panel book-stack">
      <p :role="workspace.state.error ? 'alert' : 'status'">{{ workspace.state.error || '正在打开账本…' }}</p>
      <button v-if="workspace.state.status !== 'loading'" type="button" @click="workspace.connect()">重试连接</button>
    </div>

    <!-- 1. 会员中心主视图 -->
    <RelationalMembers 
      v-else-if="active === 'members'" 
      ref="memberPage" 
      :workspace="workspace" 
      :owner="owner" 
      :writable="profileWritable"
      :cashier-writable="writable" 
      :feature="feature" 
      :announce="announce" 
      :balance-filter="memberFilter" 
      @history="openHistory" 
    />

    <!-- 2. 账务中心主视图 (包含概览、流水、报表三合一切换) -->
    <div v-else-if="active === 'ledger'" class="space-y-3.5">
      <!-- 账务分栏切换器 -->
      <div class="ledger-tabs flex gap-1 p-1 bg-slate-200/80 rounded-2xl" role="tablist" aria-label="账务视图">
        <button 
          v-for="view in ledgerViews" 
          :key="view.key" 
          type="button" 
          role="tab"
          class="flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all text-center"
          :class="ledgerView === view.key ? 'bg-white text-emerald-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'"
          :aria-selected="ledgerView === view.key" 
          @click="ledgerView = view.key"
        >
          {{ view.label }}
        </button>
      </div>

      <!-- 今日概览 -->
      <div v-if="ledgerView === 'summary'" class="space-y-3">
        <DashboardSummary :summary="businessDailySummary" :balances="businessDailyBalances" />
        <div class="ledger-shortcuts grid grid-cols-2 gap-2 mt-3">
          <button 
            type="button" 
            class="flex items-center justify-between p-3.5 rounded-2xl bg-white border border-slate-200/90 text-slate-800 font-bold text-xs shadow-xs hover:border-emerald-300 transition-all btn-press"
            @click="ledgerView = 'transactions'"
          >
            <span class="flex items-center gap-2">
              <Receipt :size="17" class="text-emerald-700" aria-hidden="true" />
              <span>查看交易明细</span>
            </span>
            <span class="text-slate-400 font-bold">›</span>
          </button>
          <button 
            type="button" 
            class="flex items-center justify-between p-3.5 rounded-2xl bg-white border border-slate-200/90 text-slate-800 font-bold text-xs shadow-xs hover:border-emerald-300 transition-all btn-press"
            @click="ledgerView = 'reports'"
          >
            <span class="flex items-center gap-2">
              <BarChart3 :size="17" class="text-emerald-700" aria-hidden="true" />
              <span>查看经营报表</span>
            </span>
            <span class="text-slate-400 font-bold">›</span>
          </button>
        </div>
      </div>

      <!-- 财务流水明细 -->
      <RelationalLedger 
        v-else-if="ledgerView === 'transactions'" 
        ref="ledgerPage" 
        :workspace="workspace" 
        :owner="owner && writable" 
        :member-id="history.id"
        :member-name="history.name" 
        @all-members="history = {}" 
      />

      <!-- 经营报表 -->
      <RelationalReports 
        v-else-if="ledgerView === 'reports'" 
        :workspace="workspace" 
      />
    </div>

    <!-- 3. 设置中心主视图 (服务定价、批量资料、备份安全、账号管理) -->
    <div v-else-if="active === 'settings'" class="space-y-3.5">
      <!-- 设置子分类胶囊导航 -->
      <div class="flex gap-1.5 overflow-x-auto p-1 bg-slate-200/80 rounded-2xl" role="tablist" aria-label="设置项目">
        <button 
          v-for="tab in settingsTabs" 
          :key="tab.id" 
          type="button" 
          role="tab"
          class="flex-1 whitespace-nowrap py-2 px-3 rounded-xl text-xs font-bold transition-all text-center"
          :class="settingsSubTab === tab.id ? 'bg-white text-emerald-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'"
          :aria-selected="settingsSubTab === tab.id"
          @click="settingsSubTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <RelationalConfiguration 
        v-if="settingsSubTab === 'configuration'" 
        :workspace="workspace" 
        :owner="owner && profileWritable" 
      />
      <RelationalBatches 
        v-else-if="settingsSubTab === 'batches'" 
        :workspace="workspace" 
        :writable="profileWritable" 
      />
      <RelationalBackup 
        v-else-if="settingsSubTab === 'backup'" 
        :workspace="workspace" 
        :controller="backup" 
      />
      <div v-else class="space-y-3">
        <slot />
      </div>
    </div>
  </main>

  <!-- 4. 底部主入口导航栏 (固定居底，三个主功能区，手势安全区适配) -->
  <nav class="app-nav fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-slate-200/90 shadow-lg pb-gesture-safe" aria-label="主导航">
    <div class="grid grid-cols-3 h-16 max-w-lg mx-auto">
      <button 
        type="button" 
        @click="active = 'members'" 
        :aria-current="active === 'members' ? 'page' : undefined" 
        aria-label="会员收银" 
        :class="{ 'nav-active': active === 'members' }" 
        class="app-nav-item flex flex-col items-center justify-center gap-1 text-slate-500 font-bold text-xs btn-press"
      >
        <UsersRound :size="22" aria-hidden="true" />
        <span>会员</span>
      </button>

      <button 
        type="button" 
        @click="openLedgerView('transactions')" 
        :aria-current="active === 'ledger' ? 'page' : undefined" 
        aria-label="财务流水" 
        :class="{ 'nav-active': active === 'ledger' }" 
        class="app-nav-item flex flex-col items-center justify-center gap-1 text-slate-500 font-bold text-xs btn-press"
      >
        <ChartNoAxesCombined :size="22" aria-hidden="true" />
        <span>账务</span>
      </button>

      <button 
        type="button" 
        @click="active = 'settings'" 
        :aria-current="active === 'settings' ? 'page' : undefined" 
        aria-label="账号与设置" 
        :class="{ 'nav-active': active === 'settings' }" 
        class="app-nav-item flex flex-col items-center justify-center gap-1 text-slate-500 font-bold text-xs btn-press"
      >
        <Settings :size="22" aria-hidden="true" />
        <span>设置</span>
      </button>
    </div>
  </nav>
</template>

<script setup>
import { computed, ref, shallowRef, watch } from 'vue';
import { UsersRound, ChartNoAxesCombined, Settings, Receipt, BarChart3 } from 'lucide-vue-next';
import RelationalMembers from './RelationalMembers.vue';
import RelationalLedger from './RelationalLedger.vue';
import RelationalReports from './RelationalReports.vue';
import RelationalConfiguration from './RelationalConfiguration.vue';
import RelationalPending from './RelationalPending.vue';
import RelationalBatches from './RelationalBatches.vue';
import RelationalBackup from './RelationalBackup.vue';
import DashboardSummary from './DashboardSummary.vue';
import { todayBusiness, businessDays } from '../relational-presentation.js';

const props = defineProps({
  workspace: { type: Object, required: true },
  owner: Boolean,
  profileWritable: Boolean,
  writable: Boolean,
  feature: { type: Function, required: true },
  announce: Function,
  backup: Object,
  identity: String
});

const active = ref('members');
const history = ref({});
const memberFilter = ref('all');
const ledgerView = ref('summary');
const settingsSubTab = ref('account');

const memberPage = ref(null);
const ledgerPage = ref(null);

const ledgerViews = computed(() => [
  { key: 'summary', label: '今日概览' },
  { key: 'transactions', label: '财务流水' },
  ...(props.feature('reports') ? [{ key: 'reports', label: '经营报表' }] : [])
]);

const settingsTabs = computed(() => [
  ...(props.feature('settings') ? [{ id: 'configuration', label: '服务与价格' }] : []),
  ...(props.workspace.batch && props.feature('members') ? [{ id: 'batches', label: '批量资料' }] : []),
  ...(props.owner && props.backup && props.feature('backup') ? [{ id: 'backup', label: '备份与恢复' }] : []),
  { id: 'account', label: '账号与设置' }
]);

const businessDailySummary = shallowRef({});
const businessDailyBalances = shallowRef({});

async function loadDailyOverview() {
  if (!props.workspace.state.book || !props.feature('reports')) return;
  const day = todayBusiness();
  try {
    const report = await props.workspace.read('reportBusiness', businessDays(day, day));
    if (report) {
      businessDailySummary.value = report.summary || {};
      businessDailyBalances.value = report.balances || {};
    }
  } catch {}
}

watch(
  () => [props.workspace.state.revision, active.value, ledgerView.value],
  () => {
    if (active.value === 'ledger' && ledgerView.value === 'summary') {
      void loadDailyOverview();
    }
  },
  { immediate: true }
);

const hasOpenAction = computed(() => Boolean(memberPage.value?.hasOpenAction || ledgerPage.value?.hasOpenAction));
const bookKey = computed(() => JSON.stringify([props.identity, props.workspace.state.book?.ledgerEpoch]));

watch(() => props.identity, () => {
  active.value = 'members';
  memberFilter.value = 'all';
  ledgerView.value = 'summary';
  settingsSubTab.value = 'account';
});

watch(bookKey, () => {
  history.value = {};
});

function openHistory(id, name) {
  history.value = { id, name };
  active.value = 'ledger';
  ledgerView.value = 'transactions';
}

function openLedgerView(view = 'transactions') {
  active.value = 'ledger';
  ledgerView.value = view;
}

function openPage(id) {
  if (['members', 'ledger'].includes(id)) {
    active.value = id;
    return true;
  }
  if (['configuration', 'batches', 'backup', 'account'].includes(id)) {
    active.value = 'settings';
    settingsSubTab.value = id;
    return true;
  }
  return false;
}

defineExpose({
  hasOpenAction,
  openAccount: () => openPage('account'),
  openBackup: () => openPage('backup'),
  openCreateMember: () => {
    active.value = 'members';
    memberPage.value?.create();
  },
  openMembers: filter => {
    if (openPage('members')) memberFilter.value = filter;
  },
  goHome: () => {
    if (props.workspace.state.busy || memberPage.value?.goBack() || ledgerPage.value?.goBack()) {
      return true;
    }
    if (active.value === 'ledger' && history.value.id) {
      history.value = {};
      active.value = 'members';
      return true;
    }
    if (active.value !== 'members') {
      active.value = 'members';
      history.value = {};
      memberFilter.value = 'all';
      return true;
    }
    return false;
  }
});
</script>
