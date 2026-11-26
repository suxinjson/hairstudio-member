<template>
  <div class="book-workbench book-stack max-w-full overflow-x-hidden" :key="bookKey">
    <RelationalPending v-if="workspace.state.book" :workspace="workspace" :owner="owner" :copy-text="copyText" />
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
      :copy-text="copyText"
      :member-notes-label="memberNotesLabel"
      :balance-filter="balanceFilter || memberFilter" 
      :search-query="searchQuery"
      @update:balance-filter="memberFilter = $event; $emit('update:balanceFilter', $event)"
      @update:search-query="$emit('update:searchQuery', $event)"
      @history="openHistory" 
    />

    <!-- 2. 账务中心：经营概览与财务流水 -->
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

      <RelationalReports v-if="ledgerView === 'summary'" :workspace="workspace" initial-period="today" />

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

    </div>

    <!-- 3. 设置中心主视图 (分类聚合概览与独立二级页面) -->
    <div v-show="active === 'settings'" class="space-y-3.5">
      <!-- 概览主视图：分类聚合菜单 -->
      <SettingsOverview
        v-if="settingsSubTab === 'overview'"
        :groups="settingsGroups"
        :store-name="storeName"
        :connection-label="connectionLabel"
        :cloud-online="online"
        @navigate="settingsSubTab = $event"
      />

      <!-- 二级设置项主视图 (带顶部返回条) -->
      <div v-show="settingsSubTab !== 'overview'" class="space-y-3">
        <div class="settings-page-heading flex items-center justify-between p-3 bg-white rounded-2xl border border-slate-200/90 shadow-xs mb-3">
          <button
            type="button"
            class="settings-back flex items-center gap-1 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl btn-press"
            :disabled="workspace.state.busy"
            @click="settingsSubTab = 'overview'"
          >
            <ChevronLeft :size="16" aria-hidden="true" />
            <span>返回设置</span>
          </button>
          <h2 class="text-sm font-black text-slate-800 m-0">{{ currentSettingsTitle }}</h2>
        </div>

        <RelationalConfiguration
          v-if="visitedSettings.has('configuration')" v-show="settingsSubTab === 'configuration'"
          :workspace="workspace"
          :owner="owner && profileWritable"
        />

        <RelationalBatches
          v-if="visitedSettings.has('batches')" v-show="settingsSubTab === 'batches'"
          :workspace="workspace"
          :writable="profileWritable"
        />

        <RelationalBackup
          v-if="visitedSettings.has('backup')" v-show="settingsSubTab === 'backup'"
          :workspace="workspace"
          :controller="backup"
        />

        <div v-if="visitedSettings.has('store')" v-show="settingsSubTab === 'store'">
          <slot name="store"><slot /></slot>
        </div>

        <div v-if="visitedSettings.has('voice')" v-show="settingsSubTab === 'voice'">
          <slot name="voice" :active="active === 'settings' && settingsSubTab === 'voice'"><slot /></slot>
        </div>

        <div v-if="settingsSubTab === 'account'">
          <slot name="account" />
          <slot />
        </div>
        <div v-else-if="settingsSubTab === 'update'">
          <slot name="update" />
        </div>

        <div v-else-if="settingsSubTab === 'help'" class="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
          <h3 class="text-base font-black text-slate-900 m-0">使用帮助</h3>
          <div class="space-y-2.5 text-xs text-slate-600 leading-relaxed">
            <p v-if="workspace.mode === 'standalone'" class="m-0"><strong>独立离线：</strong>在离线授权有效期内，本机可读取资料与记账。独立账本不会自动上传云端，请定期保存并核验外部备份。</p>
            <p v-else-if="workspace.mode === 'cloud'" class="m-0"><strong>离线收银与同步：</strong>使用授权有效时，断网可继续在本机记账；联网后自动同步。存在未明原单时，先按原号核对结果。</p>
            <p v-else class="m-0"><strong>网页收银：</strong>需要连接服务器才能读取资料和记账。请求结果不明时，先核对原单，再进行下一笔操作。</p>
            <p class="m-0"><strong>欠款与冲正：</strong>欠款交易须明确勾选同意。店主冲正会保留原记录，只调整账务；实际退款需另行办理。</p>
            <p class="m-0"><strong>备份：</strong>{{ workspace.mode === 'standalone' ? '从数据备份与恢复保存账本，并确认外部文件读回核验成功。' : '店主可在商家后台执行云端备份，备份结果需核验。' }}</p>
            <p v-if="feature('voice')" class="m-0"><strong>语音：</strong>交易成功后按门店配置播报，是否入账以交易回执为准。</p>
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
    <div class="grid h-16 max-w-lg mx-auto" :style="{ gridTemplateColumns: 'repeat(' + navigationCount + ', minmax(0, 1fr))' }">
      <button 
        type="button" 
        v-if="showMembers"
        @click="openPage('members')"
        :disabled="workspace.state.busy"
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
        v-if="showLedger"
        :disabled="workspace.state.busy"
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
        @click="openSettings"
        :disabled="workspace.state.busy"
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
import { computed, defineAsyncComponent, nextTick, reactive, ref, watch } from 'vue';
import { UsersRound, ChartNoAxesCombined, Settings, Receipt, BarChart3, ChevronLeft } from 'lucide-vue-next';
import RelationalMembers from './RelationalMembers.vue';
import RelationalLedger from './RelationalLedger.vue';
const RelationalReports = defineAsyncComponent(() => import('./RelationalReports.vue'));
const RelationalConfiguration = defineAsyncComponent(() => import('./RelationalConfiguration.vue'));
import RelationalPending from './RelationalPending.vue';
const RelationalBatches = defineAsyncComponent(() => import('./RelationalBatches.vue'));
const RelationalBackup = defineAsyncComponent(() => import('./RelationalBackup.vue'));
import SettingsOverview from './SettingsOverview.vue';

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
  balanceFilter: { type: String, default: 'all' },
  storeName: { type: String, default: '我的门店' },
  memberNotesLabel: { type: String, default: '会员偏好与备注' },
  connectionLabel: { type: String, default: '' },
  online: Boolean,
  canUpdate: Boolean,
  copyText: Function
});

const emit = defineEmits(['update:searchQuery', 'update:balanceFilter']);

const active = ref('members');
const history = ref({});
const memberFilter = ref('all');
const ledgerView = ref('summary');
const settingsSubTab = ref('overview');
const visitedSettings = reactive(new Set());
watch(settingsSubTab, page => { if (page !== 'overview') visitedSettings.add(page); }, { flush: 'sync' });

const memberPage = ref(null);
const ledgerPage = ref(null);
const showMembers = computed(() => props.feature('members'));
const showLedger = computed(() => props.feature('cashier') || props.feature('reports'));
const navigationCount = computed(() => 1 + Number(showMembers.value) + Number(showLedger.value));
watch([showMembers, showLedger], () => {
  if ((active.value === 'members' && !showMembers.value) || (active.value === 'ledger' && !showLedger.value)) {
    active.value = showMembers.value ? 'members' : showLedger.value ? 'ledger' : 'settings';
  }
}, { immediate: true });

const ledgerViews = computed(() => [
  ...(props.feature('reports') ? [{ key: 'summary', label: '经营概览' }] : []),
  ...(props.feature('cashier') ? [{ key: 'transactions', label: '财务流水' }] : [])
]);
watch(ledgerViews, views => {
  if (views.length && !views.some(view => view.key === ledgerView.value)) ledgerView.value = views[0].key;
}, { immediate: true });

const settingsGroups = computed(() => [
  {
    title: '日常经营',
    items: [
      ...(props.feature('settings') ? [{ page: 'configuration', title: '服务与价格', description: '常用项目、充值套餐与赠送规则', icon: 'scissors' }] : []),
      ...(props.feature('settings') ? [{ page: 'store', title: '门店设置', description: '门店名称与联系方式', icon: 'store' }] : []),
      ...(props.feature('voice') ? [{ page: 'voice', title: '语音播报设置', description: '播报开关、音色与试听', icon: 'voice' }] : [])
    ]
  },
  {
    title: '账号与云端',
    items: [
      { page: 'account', title: '账号与连接', description: '查看账号、授权、设备与退出登录', icon: 'account' }
    ]
  },
  {
    title: '数据安全',
    items: [
      ...(props.owner && props.backup && props.feature('backup') ? [{ page: 'backup', title: '数据备份与恢复', description: '保存、核验完整账本与恢复文件', icon: 'backup' }] : []),
      ...(props.workspace.batch && props.feature('members') ? [{ page: 'batches', title: '批量资料管理', description: '导入会员资料并核对批次进度', icon: 'batches' }] : [])
    ]
  },
  {
    title: '系统与帮助',
    items: [
      ...(props.canUpdate ? [{ page: 'update', title: '检查更新', description: '查看新版本与安装进度', icon: 'update' }] : []),
      { page: 'help', title: '使用帮助', description: '记账、原单核对与备份说明', icon: 'help' }
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
watch([active, settingsSubTab, ledgerView], async () => {
  await nextTick();
  globalThis.scrollTo?.(0, 0);
});
watch(settingsGroups, groups => {
  if (settingsSubTab.value !== 'overview' && !groups.some(group => group.items.some(item => item.page === settingsSubTab.value))) settingsSubTab.value = 'overview';
});

const hasOpenAction = computed(() => Boolean(memberPage.value?.hasOpenAction || ledgerPage.value?.hasOpenAction || active.value === 'settings' && settingsSubTab.value !== 'overview'));
const bookKey = computed(() => JSON.stringify([props.identity, props.workspace.state.book?.ledgerEpoch]));

watch(() => props.identity, () => {
  active.value = 'members';
  memberFilter.value = 'all';
  ledgerView.value = 'summary';
  settingsSubTab.value = 'overview';
  visitedSettings.clear();
});

watch(bookKey, () => {
  history.value = {};
});

function openHistory(id, name) {
  history.value = { id, name };
  active.value = 'ledger';
  emit('update:searchQuery', '');
  ledgerView.value = 'transactions';
}

function openLedgerView(view = 'transactions') {
  if (props.workspace.state.busy || !showLedger.value) return;
  history.value = {};
  active.value = 'ledger';
  ledgerView.value = ledgerViews.value.some(item => item.key === view) ? view : ledgerViews.value[0].key;
}
function openSettings() { if (!props.workspace.state.busy) { active.value = 'settings'; settingsSubTab.value = 'overview'; } }

function openPage(id) {
  if (props.workspace.state.busy) return false;
  if ((id === 'members' && !showMembers.value) || (id === 'ledger' && !showLedger.value)) return false;
  if (['members', 'ledger'].includes(id)) {
    active.value = id;
    return true;
  }
  if (settingsGroups.value.some(group => group.items.some(item => item.page === id))) {
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
  ledgerView,
  hasOpenAction,
  openAccount: () => openPage('account'),
  openUpdate: () => openPage('update'),
  openBackup: () => openPage('backup'),
  openCreateMember: async () => {
    if (!openPage('members')) return;
    active.value = 'members';
    if (memberPage.value) { memberPage.value.create(); return; }
    await nextTick();
    memberPage.value?.create();
  },
  search: () => { if (active.value === 'members') memberPage.value?.search(); else if (ledgerView.value === 'transactions') ledgerPage.value?.search(); },
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
