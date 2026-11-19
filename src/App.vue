<template>
  <div class="app-shell flex flex-col min-h-screen bg-slate-100/90 text-slate-900 select-none pb-28" @contextmenu="handleContextMenu" @pointerdown="resetExitSequence">
    
    <!-- 顶部状态栏与大搜索框 (独立组件) -->
    <AppHeader
      :active-tab="activeTab"
      v-model:customer-filter="customerFilter"
      v-model:filter-open="filterOpen"
      :notices="headerNotices"
      @open-notices="openNotices"
      :store-name="storeProfile.name"
      :ledger-view="ledgerView"
      :cloud-locked="cloudLocked"
      :cloud-binding="Boolean(cloudState.binding)"
      :cloud-online="Boolean(cloudState.online)"
      :outbox-length="cloudState.outbox?.length || 0"
      :has-storage-error="Boolean(storageError)"
      :can-create-member="canCloudWrite('createMember')"
      :connection-label="connectionLabel"
      :compact-connection-label="compactConnectionLabel"
      :current-date-text="currentDateText"
      :compact-date-text="compactDateText"
      v-model:search-query="headerSearchQuery"
      :placeholder="searchPlaceholder"
      :search-hint="searchHint"
      @open-account="openSettings('account')"
      @create-member="openNewMemberModal"
      @search="handleSearch"
      @clear-search="clearSearch"
    />

    <!-- 主视图容器 -->
    <main class="w-full max-w-4xl mx-auto px-2.5 py-3 sm:px-4 sm:py-4 space-y-3.5">
      <NoticeTicker v-if="!cloudLocked && activeTab !== 'notices'" :items="headerNotices" @open="openNotices" />
      <NoticeCenter v-if="activeTab === 'notices' && !cloudLocked" :items="notices"
        @back="backFromNotices" @navigate="navigateNotice" @act="handleNoticeAction" />
      
      <!-- 统一会员入口：快速扣款与会员档案共享一份列表。 -->
      <Customers v-if="activeTab === 'customers' && !cloudLocked"
        v-model:filter="customerFilter" :members="membersList" :ledgers="customerLedgers"
        :query="searchQuery"
        :can-consume="!storageError && canCloudWrite('consume')"
        :can-create="!storageError && canCloudWrite('createMember')"
        @select="selectMember" @consume="openConsumeModal" @create="openNewMemberModal" />

      <!-- 账务中心：默认概览，按需查看交易明细与经营报表。 -->
      <div v-if="activeTab === 'ledgers' && !cloudLocked" class="space-y-3.5">
        <div class="ledger-tabs" role="tablist" aria-label="账务视图" @keydown="moveLedgerTab">
          <button v-for="view in ledgerViews" :key="view.key" :id="`ledger-${view.key}-tab`" type="button" role="tab"
            :aria-selected="ledgerView === view.key" :aria-controls="`ledger-${view.key}`" :tabindex="ledgerView === view.key ? 0 : -1"
            @click="ledgerView = view.key">{{ view.label }}</button>
        </div>
        <LedgerTransactions
          v-if="ledgerView === 'transactions'"
          :filter-type="ledgerFilterType"
          :ledgers="filteredLedgersList"
          :search-query="ledgerSearchQuery"
          :can-write="canCloudWrite"
          :get-badge-class="getBadgeClass"
          :get-type-text="getTypeText"
          :format-phone-spaced="formatPhoneSpaced"
          :format-cent="formatCent"
          :format-time="formatTime"
          @update:filter-type="(key) => { ledgerFilterType = key; refreshLedgers(); }"
          @copy="copyMemberField"
          @refund="confirmRefundLedger"
        />
        <div v-else-if="ledgerView === 'summary'" id="ledger-summary" role="tabpanel" aria-labelledby="ledger-summary-tab" class="space-y-3">
          <!-- 今日营业收支卡片 (独立组件) -->
          <DashboardSummary
            :dashboard="dashboard"
            :is-native-app="isNativeApp"
            :cloud-state="cloudState"
            :format-cent="formatCent"
          />
          <div class="ledger-shortcuts">
            <button type="button" @click="ledgerView = 'transactions'"><ReceiptText :size="19" aria-hidden="true" /><span>查看交易明细</span><ChevronRight :size="16" aria-hidden="true" /></button>
            <button type="button" @click="ledgerView = 'reports'"><ChartNoAxesCombined :size="19" aria-hidden="true" /><span>查看经营报表</span><ChevronRight :size="16" aria-hidden="true" /></button>
          </div>
        </div>
        <BusinessReports v-else :ledgers="customerLedgers" :members="reportMembers" :now="currentDate" :format-cent="formatCent" />
      </div>

      <!-- ==================== TAB 4: 服务定价与备份安全 ==================== -->
      <div v-if="activeTab === 'settings'" class="space-y-4">
        <div v-if="!cloudLocked && settingsPath.length" class="settings-page-heading">
          <button @click="backInSettings" class="settings-back" aria-label="返回上一级设置">‹ {{ settingsPath.length > 1 ? '返回数据备份' : '返回设置' }}</button>
          <h2 class="font-black text-xl">{{ settingsTitles[settingsPage] }}</h2>
        </div>
        <WebAccountSettings v-if="isWeb && (cloudLocked || settingsPage === 'account')" :ask-confirm="askConfirm" @logged-in="activeTab = 'customers'; settingsPath = []" />
        <CloudSettings v-else-if="cloudLocked || ['account', 'users', 'activity', 'update'].includes(settingsPage)"
          :section="cloudLocked ? 'account' : settingsPage" :show-title="cloudLocked" :recovery-required="Boolean(storageError)"
          :available-update="availableUpdate" :check-update="checkUpdateManually"
          :auto-start-download="autoStartUpdateDownload" :update-resume-token="updateResumeToken"
          @auto-start-consumed="autoStartUpdateDownload = false" @navigate="openSettings" />
        <template v-if="!cloudLocked">
        <SettingsOverview
          v-if="settingsPage === 'overview' || settingsPage === 'backup'"
          :page="settingsPage"
          :cloud-state="cloudState"
          :groups="settingsGroups"
          :backup-entries="backupEntries"
          @navigate="openSettings"
          @navigate-page="openSettingsPage"
        />
        <AppVoiceSettings v-if="settingsPage === 'voice'" @navigate="openSettings" />
        <StoreSettings v-if="settingsPage === 'store'" :profile="storeProfile"
          :can-edit="!cloudState.user || cloudState.user.role === 'owner'"
          :save-profile="saveStoreProfile" :load-profile="loadStoreProfile" />
        
        <!-- 服务项目与定价管理 (独立组件) -->
        <ServiceSettings
          v-if="settingsPage === 'services'"
          :services="hairServices"
          :can-write="canCloudWrite"
          @add="openAddServiceModal"
          @edit="openEditServiceModal"
          @delete="deleteServiceItem"
        />

        <!-- 充值赠送设置 (独立组件) -->
        <RechargeSettings
          v-if="settingsPage === 'services'"
          :form="rechargeSettingsForm"
          :is-dirty="rechargeSettingsDirty"
          :can-save="canSaveRechargeSettings"
          :example="rechargeSettingsExample"
          :is-saving="savingRechargeSettings"
          :can-write="canCloudWrite"
          @change-switch="changeRechargeGiftSwitch"
          @input-rate="markRechargeSettingsDirty"
          @reload="reloadRechargeSettingsForm"
          @save="saveRechargeSettingsForm"
        />

        <!-- 微信安全备份中心 (独立组件) -->
        <WebBackupSettings v-if="isWeb && settingsPage === 'backup-files'" />
        <BackupSettings
          v-else-if="settingsPage === 'backup-files'"
          :is-exporting="isExporting"
          :storage-error="storageError"
          :is-native-app="isNativeApp"
          :can-write="canCloudWrite"
          @export-backup="handleExportBackup"
          @export-csv="handleExportCSV"
          @import-backup="handleImportBackup"
        />

        <!-- 本地历史快照管理 (独立组件) -->
        <SnapshotSettings
          v-if="!isWeb && settingsPage === 'snapshots'"
          :snapshots="localSnapshots"
          :has-storage-error="Boolean(storageError)"
          :can-write="canCloudWrite"
          :is-exporting="isExporting"
          :format-time="formatTime"
          :format-cent="formatCent"
          @create="handleCreateManualSnapshot"
          @restore="handleRestoreSnapshot"
          @share="handleShareSnapshot"
          @delete="handleDeleteSnapshot"
        />

        <!-- 经营提示 (独立组件) -->
        <SettingsHelp v-if="settingsPage === 'help'" />
        </template>
      </div>

    </main>

    <!-- 三个主入口，统一会员列表与收银操作。 -->
    <nav v-if="!cloudLocked" class="app-nav fixed bottom-0 left-0 right-0 mx-auto bg-white/95 backdrop-blur-md z-30 pb-gesture-safe" aria-label="主导航">
      <div class="grid grid-cols-3 h-16">
        <button @click="openCustomerHome" :aria-current="activeTab === 'customers' ? 'page' : undefined" :class="{ 'nav-active': activeTab === 'customers' }" class="app-nav-item btn-press">
          <UsersRound :size="23" aria-hidden="true" /><span>会员</span>
        </button>
        <button @click="openLedgerHome" :aria-current="activeTab === 'ledgers' ? 'page' : undefined" :class="{ 'nav-active': activeTab === 'ledgers' }" class="app-nav-item btn-press">
          <ChartNoAxesCombined :size="23" aria-hidden="true" /><span>账务</span>
        </button>
        <button @click="openSettings()" :aria-current="activeTab === 'settings' ? 'page' : undefined" :class="{ 'nav-active': activeTab === 'settings' }" class="app-nav-item btn-press">
          <Settings :size="23" aria-hidden="true" /><span>设置</span>
        </button>
      </div>
    </nav>

    <!-- ==================== 弹窗与抽屉层 ==================== -->

    <!-- 1. 消费扣款抽屉与确认框 (独立组件) -->
    <ConsumeModal
      :notes-label="storeProfile.memberNotesLabel"
      :member="consumingMember"
      :services="hairServices"
      v-model:amount-str="consumeAmountStr"
      v-model:summary="consumeSummary"
      v-model:show-keypad="showConsumeKeypad"
      v-model:debt-acknowledged="debtAcknowledged"
      :confirmation="consumeConfirmation"
      :is-submitting="isSubmittingConsume"
      :consume-balance-after="consumeBalanceAfter"
      :consume-debt-added="consumeDebtAdded"
      :is-consume-over-balance="isConsumeOverBalance"
      :can-submit="canSubmitConsume"
      :can-write="canCloudWrite"
      :format-phone-spaced="formatPhoneSpaced"
      :format-cent="formatCent"
      @close="closeConsumeModal"
      @backdrop-back="handleConsumeModalBack"
      @clear-amount="clearConsumeAmount"
      @open-keypad="openConsumeKeypad"
      @toggle-keypad="toggleConsumeKeypad"
      @set-preset="setConsumePreset"
      @recharge="rechargeFromConsume"
      @request-confirm="requestConsumeConfirmation"
      @cancel-confirm="consumeConfirmation = null"
      @confirm="confirmConsume"
    />

    <!-- 2. 会员充值抽屉与确认框 (独立组件) -->
    <RechargeModal
      :member="rechargingMember"
      :form="rechargeForm"
      :plans="rechargePlans"
      :settings="rechargeSettings"
      :channels="rechargeChannels"
      :credit-cent="rechargeCreditCent"
      :balance-after="rechargeBalanceAfter"
      :can-submit="canSubmitRecharge"
      :is-submitting="isSubmittingRecharge"
      :confirmation="rechargeConfirmation"
      :can-write="canCloudWrite"
      :format-cent="formatCent"
      @close="rechargingMember = null"
      @apply-plan="applyRechargePlan"
      @update-gift="updateRechargeGift"
      @request-confirm="requestRechargeConfirmation"
      @cancel-confirm="rechargeConfirmation = null"
      @confirm="confirmRecharge"
    />

    <!-- 备份恢复与智能对账弹窗 (独立组件) -->
    <BackupRestoreModal
      :request="backupRestoreRequest"
      v-model="restoreMode"
      :is-restoring="isRestoringBackup"
      :can-write="canCloudWrite"
      :format-time="formatTime"
      :format-cent="formatCent"
      @close="backupRestoreRequest = null"
      @confirm="confirmBackupRestore"
    />

    <!-- 3. 会员详情卡片抽屉 (独立组件) -->
    <MemberDetailDrawer
      :notes-label="storeProfile.memberNotesLabel"
      :member="selectedMember"
      :ledgers="currentMemberLedgers"
      :can-write="canCloudWrite"
      :format-phone-spaced="formatPhoneSpaced"
      :format-cent="formatCent"
      :format-time="formatTime"
      :get-type-text="getTypeText"
      :get-badge-class="getBadgeClass"
      @close="selectedMember = null"
      @edit="openEditMemberModal"
      @copy="copyMemberField"
      @recharge="openRechargeModal"
      @consume="openConsumeModal"
      @delete="handleDeleteMember"
    />

    <!-- 4. 新增/编辑会员档案弹窗 (独立组件) -->
    <MemberFormModal
      :notes-label="storeProfile.memberNotesLabel"
      v-model="showMemberModal"
      :editing-id="editingMemberId"
      :form="memberForm"
      :is-saving="isSavingMember"
      :can-write="canCloudWrite(editingMemberId ? 'updateMember' : 'createMember')"
      @save="submitMemberForm"
    />

    <!-- 5. 服务定价增改弹窗 (独立组件) -->
    <ServiceFormModal
      v-model="showServiceModal"
      :form="serviceForm"
      :is-saving="isSavingService"
      :can-write="canCloudWrite('saveService')"
      @save="submitServiceForm"
    />

    <!-- 6. 充值微信致谢通知卡片 (独立组件) -->
    <ReceiptModal
      :receipt="receiptModal"
      @close="receiptModal = null"
      @copy="copyReceiptText"
    />

    <!-- 浮动 Toast 消息通知 -->
    <div 
      v-if="toastMessage" 
      class="app-toast fixed top-24 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-md text-white text-sm font-black px-6 py-3.5 rounded-full shadow-2xl z-50 animate-fade-in flex items-center space-x-2 border border-slate-700"
    >
      <span>ℹ️</span>
      <span>{{ toastMessage }}</span>
    </div>

    <!-- 全局询问确认弹窗 (独立组件) -->
    <ConfirmModal
      :modal="confirmModal"
      @accept="handleConfirmModalAccept"
      @cancel="handleConfirmModalCancel"
    />

    <!-- 全局操作反馈/结果弹窗 (独立组件) -->
    <FeedbackModal
      :modal="feedbackModal"
      @close="feedbackModal = null"
    />
    <DeviceAccessPrompt v-if="showDevicePrompt" :access="cloudState.deviceAccess"
      @login="goToDeviceLogin" @later="showDevicePrompt = false" />
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import AppHeader from './components/AppHeader.vue';
import ServiceFormModal from './components/ServiceFormModal.vue';
import MemberFormModal from './components/MemberFormModal.vue';
import ReceiptModal from './components/ReceiptModal.vue';
import ServiceSettings from './components/ServiceSettings.vue';
import RechargeSettings from './components/RechargeSettings.vue';
import BackupSettings from './components/BackupSettings.vue';
import SnapshotSettings from './components/SnapshotSettings.vue';
import DashboardSummary from './components/DashboardSummary.vue';
import LedgerTransactions from './components/LedgerTransactions.vue';
import BusinessReports from './components/BusinessReports.vue';
import BackupRestoreModal from './components/BackupRestoreModal.vue';
import MemberDetailDrawer from './components/MemberDetailDrawer.vue';
import ConsumeModal from './components/ConsumeModal.vue';
import RechargeModal from './components/RechargeModal.vue';
import SettingsOverview from './components/SettingsOverview.vue';
import SettingsHelp from './components/SettingsHelp.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import FeedbackModal from './components/FeedbackModal.vue';
import DeviceAccessPrompt from './components/DeviceAccessPrompt.vue';
import StoreSettings from './components/StoreSettings.vue';
import CloudSettings from './components/CloudSettings.vue';
import WebAccountSettings from './components/WebAccountSettings.vue';
import WebBackupSettings from './components/WebBackupSettings.vue';
import AppVoiceSettings from './components/AppVoiceSettings.vue';
import Customers from './components/Customers.vue';
import NoticeCenter from './components/NoticeCenter.vue';
import NoticeTicker from './components/NoticeTicker.vue';
import { useNotices } from './composables/useNotices.js';
import { systemNotices, debtNoticeVersion } from './notices.js';
import { UsersRound, ReceiptText, Settings, ChartNoAxesCombined, ChevronRight } from 'lucide-vue-next';
import { cloudClient, copyToClipboard } from './cloud-device.js';
import { appVoicePlayer, appVoiceContext } from './app-voice.js';
import { canWrite } from './sync-protocol.js';
import { normalizeStoreProfile } from './store-profile.js';

import { useFeedback } from './composables/useFeedback.js';
import { useFormatters } from './composables/useFormatters.js';
import { useSettingsNav } from './composables/useSettingsNav.js';
import { useLedgerSearch } from './composables/useLedgerSearch.js';
import { useMemberCrud } from './composables/useMemberCrud.js';
import { useServiceCrud } from './composables/useServiceCrud.js';
import { useRecharge } from './composables/useRecharge.js';
import { useConsume } from './composables/useConsume.js';
import { useBackupOperations } from './composables/useBackupOperations.js';
import { useRechargeSettings } from './composables/useRechargeSettings.js';
import { useLedgerRefund } from './composables/useLedgerRefund.js';
import { useAppBackHandler } from './composables/useAppBackHandler.js';
import { useAppUpdate } from './composables/useAppUpdate.js';

const isNativeApp = Capacitor.isNativePlatform();
const localDb = cloudClient.getDb();
const isWeb = localDb.webOnly === true;

// 导航与页面状态
const activeTab = ref('customers');
const ledgerView = ref('summary');
const ledgerViews = [
  { key: 'summary', label: '收银概览' },
  { key: 'transactions', label: '交易明细' },
  { key: 'reports', label: '经营报表' }
];
function openCustomerHome() {
  activeTab.value = 'customers';
  void nextTick(() => window.scrollTo?.(0, 0));
}
function openLedgerHome() {
  activeTab.value = 'ledgers';
  ledgerView.value = 'summary';
  void nextTick(() => window.scrollTo?.(0, 0));
}
function moveLedgerTab(event) {
  const index = ledgerViews.findIndex(view => view.key === ledgerView.value);
  let next;
  if (event.key === 'ArrowRight') next = (index + 1) % ledgerViews.length;
  if (event.key === 'ArrowLeft') next = (index + ledgerViews.length - 1) % ledgerViews.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = ledgerViews.length - 1;
  if (next === undefined) return;
  event.preventDefault();
  ledgerView.value = ledgerViews[next].key;
  event.currentTarget.querySelectorAll('[role=tab]')[next]?.focus();
}
const autoStartUpdateDownload = ref(false);
const updateResumeToken = ref(0);

// 核心数据模型
const dashboard = ref({});
const membersList = ref([]);
const reportMembers = ref([]);
const customerLedgers = ref([]);
const customerFilter = ref('recent');
const filterOpen = ref(false);
const debtVersion = ref('');
const ledgerSnapshotScope = ref(null);
const noticePreviousTab = ref('customers');
watch(activeTab, () => { filterOpen.value = false; });
const ledgersList = ref([]);
const hairServices = ref([]);
const rechargePlans = ref([]);

const storageError = ref('');
const selectedMember = ref(null);
const receiptModal = ref(null);
const cloudState = ref(cloudClient.snapshot());
const storeProfile = computed(() => normalizeStoreProfile(
  cloudState.value.binding || cloudState.value.user ? cloudState.value.storeProfile || {} : cloudClient.getStoreProfile()));
const saveStoreProfile = (profile, version) => cloudClient.saveStoreProfile(profile, version);
const loadStoreProfile = () => cloudClient.loadStoreProfile();
const cloudLocked = computed(() => isNativeApp ? cloudState.value.deviceAccess?.allowed === false : (!cloudState.value.user || !cloudState.value.binding));
const showDevicePrompt = ref(false);
let devicePromptHandled = false;
let returningFromDeviceLock = false;
let deviceEntryChecking = true;
function promptForDevice(state = cloudState.value) {
  if (!isNativeApp || devicePromptHandled || state.deviceAccess && !state.deviceAccess.ready) return;
  if (state.deviceAccess?.allowed === false || (state.user || state.binding) && (!state.online || state.syncLoginRequired)) {
    devicePromptHandled = true; showDevicePrompt.value = true;
  }
}
function goToDeviceLogin() { showDevicePrompt.value = false; openSettings('account'); }

const rechargeChannels = [
  { value: '微信支付', label: '微信支付' },
  { value: '支付宝', label: '支付宝' },
  { value: '现金', label: '现金' },
  { value: 'POS刷卡', label: 'POS刷卡' },
  { value: '银行转账', label: '银行转账' }
];

// 反馈与确认弹窗
const {
  toastMessage,
  feedbackModal,
  confirmModal,
  showToast,
  showFeedback,
  askConfirm,
  handleConfirmModalAccept,
  handleConfirmModalCancel
} = useFeedback();

const updateReady = ref(false);
const { availableUpdate, checkManually: checkUpdateManually, checkOnOpen: checkUpdateOnOpen, onBackground: pauseUpdateCheck } = useAppUpdate({
  state: cloudState, ready: updateReady, isNativeApp, promptAutomatically: false
});
const autoNotices = computed(() => systemNotices({ dashboard: dashboard.value, debtVersion: debtVersion.value,
  state: cloudState.value, storageError: storageError.value, isWeb, availableUpdate: availableUpdate.value }));
const ledgerScope = () => JSON.stringify([cloudState.value.serverUrl || 'local',
  cloudState.value.binding?.storeId || cloudState.value.user?.storeId || 'local']);
const noticeLedgerReady = computed(() => ledgerSnapshotScope.value === ledgerScope() && !storageError.value &&
  !cloudState.value.bindingRecovery && !cloudState.value.cloudAdoption && (!isWeb || cloudState.value.status === 'synced'));
const { scope: noticeScope, items: notices, headerItems: headerNotices, act: actOnNotice } = useNotices({
  state: cloudState, systemItems: autoNotices, ledgerReady: noticeLedgerReady
});
function openNotices() {
  if (activeTab.value !== 'notices') noticePreviousTab.value = activeTab.value;
  activeTab.value = 'notices'; window.scrollTo?.(0, 0);
}
function backFromNotices() {
  activeTab.value = noticePreviousTab.value;
  void nextTick(() => document.querySelector('.notice-entry')?.focus());
}
function navigateNotice(action) {
  if (action === 'debt') { activeTab.value = 'customers'; clearSearch(); customerFilter.value = 'debt'; }
  else if (action === 'update') { autoStartUpdateDownload.value = true; openSettings('update'); }
  else openSettings(action);
  window.scrollTo?.(0, 0);
}
async function handleNoticeAction(item, action) {
  const scope = noticeScope.value;
  if (action === 'delete' && !await askConfirm({ title: '删除这条提醒？',
    message: '从本机提醒列表移除，情况有新变化时会再次提醒。', confirmText: '删除提醒' })) return;
  if (scope !== noticeScope.value || cloudLocked.value) return;
  try { if (actOnNotice(item, action)) showToast(action === 'delete' ? '提醒已删除' : '已知晓，顶部不再提醒'); }
  catch (error) { showToast('提醒处理失败：' + error.message); }
}

function broadcastTransaction(type, params) {
  return appVoicePlayer.broadcast(type, params, {
    onError: error => showToast('记账已完成，语音播报失败：' + error.message)
  });
}

// 格式化工具
const {
  currentDate,
  compactDateText,
  currentDateText,
  formatCent,
  formatPhoneSpaced,
  formatTime,
  getTypeText,
  getBadgeClass
} = useFormatters();

// 设置导航
const {
  settingsPath,
  settingsPage,
  settingsTitles,
  backupEntries,
  settingsGroups,
  openSettings,
  openSettingsPage,
  backInSettings
} = useSettingsNav({ activeTab, cloudState, isNativeApp, isWeb });

// 充值赠送规则
const {
  rechargeSettings,
  rechargeSettingsForm,
  rechargeSettingsDirty,
  markRechargeSettingsDirty,
  reloadRechargeSettingsForm,
  saving: savingRechargeSettings,
  changeRechargeGiftSwitch,
  canSaveRechargeSettings,
  rechargeSettingsExample,
  saveRechargeSettingsForm
} = useRechargeSettings({
  localDb,
  showToast,
  showFeedback,
  formatCent
});

// 刷新全量数据
function refreshAll() {
  currentDate.value = new Date();
  const snapshotScope = ledgerScope();
  try {
    localDb.init();
    const nextMembers = localDb.getMembers(searchQuery.value);
    const nextReportMembers = searchQuery.value.trim() ? localDb.getMembers() : nextMembers;
    const nextDashboard = localDb.getDashboard();
    const nextServices = localDb.getServices();
    const nextSettings = localDb.getRechargeSettings();
    const nextLedgers = localDb.getLedgers({ type: ledgerFilterType.value });
    const nextCustomerLedgers = localDb.getLedgers();

    membersList.value = nextMembers;
    reportMembers.value = nextReportMembers;
    dashboard.value = nextDashboard;
    debtVersion.value = debtNoticeVersion(nextReportMembers, nextCustomerLedgers);
    customerLedgers.value = nextCustomerLedgers;
    ledgersList.value = nextLedgers;
    hairServices.value = nextServices;
    rechargeSettings.value = nextSettings;
    rechargePlans.value = localDb.getRechargePlans();
    localSnapshots.value = localDb.getLocalSnapshots();
    if (selectedMember.value) selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    if (consumingMember.value) consumingMember.value = localDb.getMemberById(consumingMember.value.id);
    if (rechargingMember.value) rechargingMember.value = localDb.getMemberById(rechargingMember.value.id);
    storageError.value = '';
    ledgerSnapshotScope.value = snapshotScope;

    if (!rechargeSettingsDirty.value) {
      rechargeSettingsForm.value = { ...nextSettings };
    }
  } catch (error) {
    ledgerSnapshotScope.value = null;
    storageError.value = error.message;
    if (activeTab.value !== 'settings' || settingsPage.value === 'overview') openSettings('backup-files');
    membersList.value = [];
    reportMembers.value = [];
    customerLedgers.value = [];
    ledgersList.value = [];
    selectedMember.value = null;
    localSnapshots.value = localDb.getLocalSnapshots();
  }
}

function refreshLedgers() {
  ledgersList.value = localDb.getLedgers({ type: ledgerFilterType.value });
}

// 搜索联动
const {
  searchQuery,
  ledgerSearchQuery,
  ledgerFilterType,
  headerSearchQuery,
  searchPlaceholder,
  searchHint,
  filteredLedgersList,
  handleSearch,
  clearSearch
} = useLedgerSearch({
  activeTab,
  ledgersList,
  membersList,
  storageError,
  localDb,
  refreshAll,
  refreshLedgers,
  getTypeText
});

// 会员与服务管理
const {
  showMemberModal,
  isSavingMember,
  editingMemberId,
  memberForm,
  openNewMemberModal,
  openEditMemberModal,
  submitMemberForm,
  handleDeleteMember
} = useMemberCrud({
  localDb,
  refreshAll,
  selectMember,
  showToast,
  showFeedback,
  askConfirm,
  selectedMember
});

const {
  showServiceModal,
  isSavingService,
  serviceForm,
  openAddServiceModal,
  openEditServiceModal,
  submitServiceForm,
  deleteServiceItem
} = useServiceCrud({
  localDb,
  hairServices,
  showToast,
  showFeedback,
  askConfirm
});

// 充值管理
const {
  rechargingMember,
  rechargeForm,
  rechargeConfirmation,
  isSubmittingRecharge,
  rechargeCreditCent,
  rechargeBalanceAfter,
  canSubmitRecharge,
  openRechargeModal,
  applyRechargePlan,
  updateRechargeGift,
  requestRechargeConfirmation,
  confirmRecharge
} = useRecharge({
  localDb,
  getStoreProfile: () => storeProfile.value,
  rechargeSettings,
  refreshAll,
  selectedMember,
  receiptModal,
  broadcast: broadcastTransaction,
  showToast,
  showFeedback,
  formatCent
});

// 扣款管理
const {
  consumingMember,
  consumeAmountStr,
  consumeSummary,
  isSubmittingConsume,
  showConsumeKeypad,
  consumeConfirmation,
  debtAcknowledged,
  consumeBalanceAfter,
  consumeDebtAdded,
  isConsumeOverBalance,
  canSubmitConsume,
  openConsumeModal,
  handleConsumeModalBack,
  closeConsumeModal,
  openConsumeKeypad,
  toggleConsumeKeypad,
  clearConsumeAmount,
  setConsumePreset,
  requestConsumeConfirmation,
  confirmConsume,
  rechargeFromConsume
} = useConsume({
  localDb,
  hairServices,
  refreshAll,
  selectedMember,
  showToast,
  showFeedback,
  formatCent,
  openRechargeModal,
  broadcast: broadcastTransaction
});

// 备份与快照管理
const {
  isExporting,
  backupRestoreRequest,
  isRestoringBackup,
  restoreMode,
  localSnapshots,
  handleExportBackup,
  handleExportCSV,
  handleCreateManualSnapshot,
  handleDeleteSnapshot,
  handleShareSnapshot,
  handleRestoreSnapshot,
  handleImportBackup,
  confirmBackupRestore
} = useBackupOperations({
  localDb,
  cloudClient,
  refreshAll,
  selectedMember,
  consumingMember,
  rechargingMember,
  showToast,
  showFeedback,
  askConfirm
});

// 云端与权限
const connectionLabel = computed(() => {
  if (isNativeApp && cloudState.value.deviceAccess?.allowed === false) return cloudState.value.deviceAccess.reason;
  if (isWeb) {
    if (cloudState.value.locked) return '已锁屏 · 请重新登录';
    if (!cloudState.value.user) return '请登录服务器账号';
    if (cloudState.value.pending) return '原操作结果待确认';
    if (cloudState.value.error) return '服务器连接或提交失败';
    return cloudState.value.online ? '服务器账本已加载' : '正在加载服务器账本';
  }
  if (!cloudState.value.user) return isNativeApp && !cloudState.value.binding ? '本机运行' : '未登录云端';
  if (!cloudState.value.online) return '当前离线（已保存在本机）';
  if (cloudState.value.syncLoginRequired) return '登录失效 · 待重新登录';
  if (cloudState.value.status === 'conflict') return '需核对云端版本';
  if (cloudState.value.syncStatus === 'checking') return '正在核验云端账本';
  if (cloudState.value.syncStatus === 'error') return '同步失败 · 待重新确认';
  if (cloudState.value.outbox.length) return `联网 · 待同步 ${cloudState.value.outbox.length} 笔`;
  return cloudState.value.syncStatus === 'confirmed' ? '在线同步' : '账本待确认';
});
const compactConnectionLabel = computed(() => {
  if (isWeb) return cloudState.value.locked ? '已锁屏' : !cloudState.value.user ? '未登录' : cloudState.value.pending ? '待确认' : cloudState.value.error ? '请求失败' : cloudState.value.online ? '在线' : '加载中';
  if (!cloudState.value.user) return isNativeApp && !cloudState.value.binding ? '本机' : '未登录';
  if (!cloudState.value.online) return '离线';
  if (cloudState.value.syncLoginRequired) return '待登录';
  if (cloudState.value.status === 'conflict') return '待核对';
  if (cloudState.value.syncStatus === 'checking') return '同步中';
  if (cloudState.value.syncStatus === 'error') return '同步失败';
  return cloudState.value.outbox.length ? '待同步' : cloudState.value.syncStatus === 'confirmed' ? '已同步' : '待确认';
});
const stopCloudSubscription = cloudClient.subscribe((state) => {
  if (appVoiceContext(state) !== appVoiceContext(cloudState.value)) appVoicePlayer.stop();
  cloudState.value = state;
  if (isNativeApp && state.deviceAccess?.allowed === false) {
    returningFromDeviceLock = true;
    activeTab.value = 'settings'; settingsPath.value = ['account'];
    consumingMember.value = null; rechargingMember.value = null; selectedMember.value = null;
    showMemberModal.value = false; showServiceModal.value = false; backupRestoreRequest.value = null;
  } else if (isNativeApp && returningFromDeviceLock && state.deviceAccess?.allowed === true) {
    returningFromDeviceLock = false;
    activeTab.value = 'customers'; settingsPath.value = [];
    showDevicePrompt.value = false;
  }
  if (isNativeApp && !state.busy && !deviceEntryChecking) promptForDevice(state);
  if (!isNativeApp && (!state.user || !state.binding)) {
    activeTab.value = 'settings';
    if (isWeb) settingsPath.value = ['account'];
    selectedMember.value = null;
    consumingMember.value = null;
    rechargingMember.value = null;
    showMemberModal.value = false;
    showServiceModal.value = false;
    receiptModal.value = null;
    backupRestoreRequest.value = null;
  }
});
function canCloudWrite(method) {
  const state = cloudState.value;
  if (isNativeApp && state.deviceAccess?.allowed === false) return false;
  if (isWeb) return Boolean(state.user && state.status === 'synced' && !state.pending && !state.busy && canWrite(state.user.role, method));
  if (state.cloudAdoption || state.bindingRecovery) return false;
  if (!state.binding) return isNativeApp && (!state.user || canWrite(state.user.role, method));
  return canWrite(state.user?.role, method);
}

const currentMemberLedgers = computed(() => {
  if (!selectedMember.value) return [];
  return customerLedgers.value.filter((l) => l.memberId === selectedMember.value.id);
});
function selectMember(m) {
  selectedMember.value = localDb.getMemberById(m.id) || m;
}

// 错单撤回 / 冲正
const { confirmRefundLedger } = useLedgerRefund({
  localDb,
  refreshAll,
  selectedMember,
  askConfirm,
  showToast,
  showFeedback,
  formatCent
});

// 复制工具
async function copyMemberField(text, label) {
  try {
    await copyToClipboard(text);
    showToast(label + '已复制');
  } catch (error) {
    showToast(error.message || '复制失败，请重试');
  }
}
async function copyReceiptText(text) {
  if (!text) return;
  try {
    await copyToClipboard(text);
    showToast('通知文本已复制到剪贴板，可发给微信好友！');
  } catch (error) {
    showToast(error.message || '复制失败，请长按文本复制');
  }
}
function handleContextMenu(event) {
  if (!event.target.closest('input:not([type="file"]), textarea')) event.preventDefault();
}

// 物理返回键与退出控制
const {
  resetExitSequence,
  closeTopLayer,
  handleBackButton,
  handleWindowKeydown
} = useAppBackHandler({
  exitApp: () => CapacitorApp.exitApp(),
  showToast,
  confirmModal,
  handleConfirmModalCancel,
  feedbackModal,
  receiptModal,
  backupRestoreRequest,
  showServiceModal,
  showMemberModal,
  consumeConfirmation,
  rechargeConfirmation,
  rechargingMember,
  consumingMember,
  showConsumeKeypad,
  closeConsumeModal,
  selectedMember,
  activeTab,
  filterOpen,
  backFromNotices,
  settingsPath,
  cloudLocked,
  backInSettings
});

// 生命周期与后台刷新
let dailyRefreshTimer = null;
let appStateListener = null;
let backButtonListener = null;
let isUnmounted = false;
let stopCloud = null;

function scheduleDailyRefresh() {
  clearTimeout(dailyRefreshTimer);
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  dailyRefreshTimer = setTimeout(refreshAppState, midnight.getTime() - now.getTime());
}

function refreshAppState() {
  if (isUnmounted) return;
  refreshAll();
  scheduleDailyRefresh();
  devicePromptHandled = false;
  deviceEntryChecking = true;
  cloudClient.sync().catch(() => {}).finally(() => { deviceEntryChecking = false; promptForDevice(); });
}

function refreshOnResume() {
  if (isUnmounted) return;
  refreshAppState();
  void checkUpdateOnOpen();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') refreshOnResume();
  else pauseUpdateCheck();
}

onMounted(async () => {
  refreshAll();
  scheduleDailyRefresh();
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', refreshOnResume);
  window.addEventListener('cloud-data-updated', refreshAll);
  window.addEventListener('keydown', handleWindowKeydown);

  cloudClient
    .start()
    .then(async (stop) => {
      if (isUnmounted) stop();
      else stopCloud = stop;
      if (!isUnmounted) {
        updateReady.value = true;
        await cloudClient.sync().catch(() => {}); deviceEntryChecking = false; promptForDevice();
      }
    })
    .catch((error) => showFeedback(error.message, 'error', { title: '云端连接未启动' }));

  if (isNativeApp) {
    try {
      const listener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) { updateResumeToken.value++; refreshOnResume(); }
        else pauseUpdateCheck();
      });
      if (isUnmounted) listener.remove();
      else appStateListener = listener;
    } catch (error) {
      console.warn('应用状态监听未能启动:', error);
    }

    try {
      const backListener = await CapacitorApp.addListener('backButton', handleBackButton);
      if (isUnmounted) backListener.remove();
      else backButtonListener = backListener;
    } catch (error) {
      console.warn('返回键监听未能启动:', error);
    }
  }
});

onUnmounted(() => {
  isUnmounted = true;
  appVoicePlayer.stop();
  resetExitSequence();
  clearTimeout(dailyRefreshTimer);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('focus', refreshOnResume);
  window.removeEventListener('cloud-data-updated', refreshAll);
  window.removeEventListener('keydown', handleWindowKeydown);
  stopCloudSubscription();
  stopCloud?.();
  appStateListener?.remove().catch((error) => console.warn('应用状态监听清理失败:', error));
  backButtonListener?.remove().catch((error) => console.warn('返回键监听清理失败:', error));
});
</script>
