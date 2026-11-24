<template>
  <div class="book-workbench book-stack pb-24 max-w-full overflow-x-hidden" :key="bookKey">
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
      :balance-filter="balanceFilter || memberFilter" 
      :search-query="searchQuery"
      @update:balance-filter="memberFilter = $event; $emit('update:balanceFilter', $event)"
      @update:search-query="$emit('update:searchQuery', $event)"
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
        :search-query="searchQuery"
        @all-members="history = {}" 
      />

      <!-- 经营报表 -->
      <RelationalReports 
        v-else-if="ledgerView === 'reports'" 
        :workspace="workspace" 
      />
    </div>

    <!-- 3. 设置中心主视图 (分类聚合概览与独立二级页面) -->
    <div v-else-if="active === 'settings'" class="space-y-3.5">
      <!-- 概览主视图：分类聚合菜单 -->
      <SettingsOverview
        v-if="settingsSubTab === 'overview'"
        :groups="settingsGroups"
        :store-name="workspace.state.storeProfile?.name || '我的门店'"
        :connection-label="workspace.state.user?.displayName || ''"
        :cloud-online="Boolean(workspace.state.book)"
        @navigate="settingsSubTab = $event"
      />

      <!-- 二级设置项主视图 (带顶部返回条) -->
      <div v-else class="space-y-3">
        <div class="flex items-center justify-between p-3 bg-white rounded-2xl border border-slate-200/90 shadow-xs mb-3">
          <button
            type="button"
            class="flex items-center gap-1 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl btn-press"
            @click="settingsSubTab = 'overview'"
          >
            <ChevronLeft :size="16" aria-hidden="true" />
            <span>返回设置</span>
          </button>
          <h2 class="text-sm font-black text-slate-800 m-0">{{ currentSettingsTitle }}</h2>
          <span class="w-16"></span>
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

        <div v-else-if="settingsSubTab === 'store'">
          <slot name="store"><slot /></slot>
        </div>

        <div v-else-if="settingsSubTab === 'voice'">
          <slot name="voice"><slot /></slot>
        </div>

        <div v-else-if="settingsSubTab === 'account' || settingsSubTab === 'update'">
          <slot name="account" />
          <slot name="update" />
          <slot />
        </div>

        <div v-else-if="settingsSubTab === 'help'" class="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
          <h3 class="text-base font-black text-slate-900 m-0">💡 使用帮助与说明</h3>
          <div class="space-y-2.5 text-xs text-slate-600 leading-relaxed">
            <p class="m-0"><strong>离线与云端双模：</strong>本机具备独立离线账本，断网时仍可顺畅记账扣款；联网后自动与云端服务器比对同步。</p>
            <p class="m-0"><strong>数据安全与冲正：</strong>每笔消费与充值皆生成唯一单号，已入账记录支持店主安全冲正撤回，不留坏账死账。</p>
            <p class="m-0"><strong>备份与防丢失：</strong>建议定期在【数据安全 → 数据备份与恢复】中导出账本或保存本地快照，确保数据永久高可用。</p>
            <p class="m-0"><strong>语音播报：</strong>收银结算后支持高保真语音播报提示，并支持外接智能音箱播报。</p>
          </div>
        </div>

        <div v-else class="space-y-3">
          <slot />
        </div>
      </div>
    </div>
  </div>

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
        @click="active = 'settings'; settingsSubTab = 'overview'" 
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
import { UsersRound, ChartNoAxesCombined, Settings, Receipt, BarChart3, ChevronLeft } from 'lucide-vue-next';
import RelationalMembers from './RelationalMembers.vue';
import RelationalLedger from './RelationalLedger.vue';
import RelationalReports from './RelationalReports.vue';
import RelationalConfiguration from './RelationalConfiguration.vue';
import RelationalPending from './RelationalPending.vue';
import RelationalBatches from './RelationalBatches.vue';
import RelationalBackup from './RelationalBackup.vue';
import DashboardSummary from './DashboardSummary.vue';
import SettingsOverview from './SettingsOverview.vue';
import { todayBusiness, businessDays } from '../relational-presentation.js';

const props = defineProps({
  workspace: { type: Object, required: true },
  owner: Boolean,
  profileWritable: Boolean,
  writable: Boolean,
  feature: { type: Function, required: true },
  announce: Function,
  backup: Object,
  identity: String,
  searchQuery: { type: String, default: '' },
  balanceFilter: { type: String, default: 'all' }
});

const emit = defineEmits(['update:searchQuery', 'update:balanceFilter']);

const active = ref('members');
const history = ref({});
const memberFilter = ref('all');
const ledgerView = ref('summary');
const settingsSubTab = ref('overview');

const memberPage = ref(null);
const ledgerPage = ref(null);

const ledgerViews = computed(() => [
  { key: 'summary', label: '今日概览' },
  { key: 'transactions', label: '财务流水' },
  ...(props.feature('reports') ? [{ key: 'reports', label: '经营报表' }] : [])
]);

const settingsGroups = computed(() => [
  {
    title: '日常经营',
    items: [
      ...(props.feature('settings') ? [{ page: 'configuration', title: '服务与价格', description: '管理常用项目定价与充值套餐规则', icon: '🛍️' }] : []),
      ...(props.feature('settings') ? [{ page: 'store', title: '门店设置', description: '门店名称、联系方式与小票通知', icon: '🏪' }] : []),
      ...(props.feature('voice') ? [{ page: 'voice', title: '语音播报设置', description: '播报开关、音色调节与测试播报', icon: '📢' }] : [])
    ]
  },
  {
    title: '账号与云端',
    items: [
      { page: 'account', title: '账号与连接', description: '当前店员账号、云端连接状态与设备', icon: '☁️' }
    ]
  },
  {
    title: '数据安全',
    items: [
      ...(props.owner && props.backup && props.feature('backup') ? [{ page: 'backup', title: '数据备份与恢复', description: '导出完整账本、本地快照与恢复数据', icon: '🛡️' }] : []),
      ...(props.workspace.batch && props.feature('members') ? [{ page: 'batches', title: '批量资料管理', description: '批量导入会员档案与历史任务', icon: '📁' }] : [])
    ]
  },
  {
    title: '系统与帮助',
    items: [
      { page: 'update', title: '检查更新', description: '检查并安装最新客户端版本', icon: '⬆️' },
      { page: 'help', title: '使用帮助', description: '离线模式、账本同步与常见问题说明', icon: '💡' }
    ]
  }
].filter(g => g.items.length > 0));

const settingsTitles = {
  configuration: '服务与价格',
  store: '门店设置',
  voice: '语音播报设置',
  account: '账号与连接',
  backup: '数据备份与恢复',
  batches: '批量资料管理',
  update: '检查更新',
  help: '使用帮助'
};

const currentSettingsTitle = computed(() => settingsTitles[settingsSubTab.value] || '设置');

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
  settingsSubTab.value = 'overview';
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
  if (['configuration', 'batches', 'backup', 'account', 'store', 'voice', 'update', 'help'].includes(id)) {
    active.value = 'settings';
    settingsSubTab.value = id;
    return true;
  }
  return false;
}

watch(() => props.balanceFilter, (val) => {
  if (val && val !== memberFilter.value) {
    memberFilter.value = val;
  }
});

defineExpose({
  activeTab: active,
  hasOpenAction,
  openAccount: () => openPage('account'),
  openBackup: () => openPage('backup'),
  openCreateMember: () => {
    active.value = 'members';
    memberPage.value?.create();
  },
  openMembers: filter => {
    if (openPage('members')) {
      memberFilter.value = filter;
      emit('update:balanceFilter', filter);
    }
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
    if (active.value === 'settings' && settingsSubTab.value !== 'overview') {
      settingsSubTab.value = 'overview';
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
