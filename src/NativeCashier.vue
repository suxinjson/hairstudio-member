<template>
  <div class="app-shell flex flex-col min-h-screen bg-slate-100/90 text-slate-900 select-none max-w-full overflow-x-hidden">
    <!-- 顶部状态栏与大搜索框 (AppHeader 经典复刻) -->
    <AppHeader
      :active-tab="workbench?.activeTab || 'members'"
      :ledger-view="workbench?.ledgerView || 'summary'"
      :show-member-filter="false"
      :show-create-member="state.user?.role !== 'viewer' && feature('members')"
      v-model:customer-filter="headerCustomerFilter"
      v-model:filter-open="headerFilterOpen"
      :notices="notices.headerItems.value"
      :store-name="state.storeProfile.name"
      :connection-label="connectionLabel"
      :cloud-locked="!unlocked"
      :cloud-online="Boolean(state.online)"
      :has-storage-error="Boolean(workspace.state.error)"
      :can-create-member="canWrite && Boolean(workspace.state.book) && !workspace.state.busy && !workspace.state.pending && !workspace.state.pendingError"
      v-model:search-query="headerSearchQuery"
      @open-notices="noticesOpen = true"
      @create-member="openNewMember"
      @clear-search="clearSearch"
      @search="refreshSearch"
    />

    <main class="cashier-content w-full max-w-4xl mx-auto space-y-3.5 flex-1 min-w-0">
      <p v-if="message || state.error" class="book-panel book-alert" role="alert">{{ message || state.error }}</p>
      <div v-if="!state.ready" class="book-panel book-stack">
        <p role="status">正在读取设备授权…</p><button v-if="state.error" type="button" @click="start">重试</button>
      </div>
      <template v-else-if="!unlocked">
        <form v-if="!state.user" class="book-panel book-stack bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-200" @submit.prevent="signIn">
          <h2>{{ standalone ? '登录本地账号' : '登录门店账号' }}</h2>
          <label v-if="!standalone">服务器<input v-model.trim="origin" type="url" autocomplete="url" :readonly="Boolean(state.binding)" required></label>
          <label>账号<input v-model.trim="username" autocomplete="username" autocapitalize="none" required></label>
          <label>密码<PasswordField v-model="password" autocomplete="current-password" :disabled="accountBusy || state.busy" required /></label>
          <button class="book-primary" type="submit" :disabled="accountBusy || state.busy">登录</button>
        </form>
        <div v-else class="book-panel book-stack bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-200">
          <p role="status">{{ state.deviceAccess.reason }}</p>
          <button type="button" :disabled="accountBusy || state.busy" @click="resume">重新核验使用授权</button>
          <button type="button" :disabled="accountBusy || state.busy || workspace.state.busy" @click="signOut">{{ standalone ? '退出并续期 / 重新登录' : '退出并重新登录' }}</button>
        </div>
        <div v-if="state.binding?.mode !== 'cloud' && !state.user" class="book-panel bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-200">
          <OfflineActivation :state="state" :activate-offline="session.activateOffline" :copy-text="copyText" />
        </div>
      </template>
      <template v-else>
        <NoticeCenter v-if="noticesOpen" :items="notices.items.value" @back="noticesOpen = false" @navigate="noticeAction" @act="noticeReceipt" />
        <NoticeTicker v-else :items="notices.headerItems.value" @open="noticesOpen = true" />
        <div v-show="!noticesOpen" class="book-stack">
          <RelationalWorkbench ref="workbench" :workspace="workspace" :identity="identity" :owner="owner" :writable="canWrite"
            :profile-writable="canWrite && (standalone || state.online)" :feature="feature" :announce="announce" :backup="standalone ? archive : null"
            :store-name="state.storeProfile.name" :connection-label="connectionLabel" :online="state.online" :can-update="!standalone" :copy-text="copyText"
            v-model:search-query="headerSearchQuery" v-model:balance-filter="headerCustomerFilter">
            <template #connection>
              <RelationalNativeSync v-if="workspace.state.book && !standalone" :workspace="workspace" :online="state.online" :owner="owner" @reconnect="resume" />
            </template>
            <template #account>
              <section class="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
                <div class="flex items-center justify-between">
                  <h3 class="text-base font-black text-slate-900 m-0">账号与设备</h3>
                  <span class="px-2.5 py-0.5 rounded-full text-xs font-bold" :class="state.online ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'">
                    {{ standalone ? '独立离线账本' : state.online ? '云端已连接' : '离线可用' }}
                  </span>
                </div>
                <p class="text-xs text-slate-600 m-0">当前账号：<strong>{{ state.user.displayName }}</strong>（{{ owner ? '店主' : state.user.role === 'viewer' ? '只读账号' : '收银员' }}）</p>
                <div class="pt-2">
                  <label class="text-xs font-bold text-slate-500 block mb-1">设备标识</label>
                  <div class="flex items-center gap-2">
                    <input :value="state.deviceId" readonly class="text-xs font-mono p-2 bg-slate-50 border border-slate-200 rounded-xl flex-1 text-slate-700" />
                    <button type="button" @click="copyDevice" class="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold shrink-0 btn-press">复制</button>
                  </div>
                </div>
                <p v-if="state.deviceAccess.authorizedUntil" class="text-xs text-slate-500 m-0">授权有效期至：{{ new Date(state.deviceAccess.authorizedUntil).toLocaleString() }}</p>
                <button type="button" :disabled="accountBusy || state.busy || workspace.state.busy" @click="signOut" class="account-signout">退出登录 / 切换账号</button>
                <div class="pt-2 border-t border-slate-100">
                  <a v-if="!standalone && state.online" :href="state.serverUrl + '/admin/'" target="_blank" rel="noopener noreferrer" class="text-xs font-bold text-emerald-700 hover:text-emerald-800 block">
                    打开电脑端商家后台（员工、设备、审计和云端备份） ›
                  </a>
                </div>
              </section>
            </template>
            <template #store>
              <StoreSettings v-if="feature('settings')" :profile="state.storeProfile" :can-edit="owner && !standalone && state.online"
                :load-profile="standalone ? undefined : session.loadStoreProfile" :save-profile="session.saveStoreProfile" />
            </template>
            <template #voice>
              <VoiceSettings v-if="feature('voice') && !standalone && state.online" :api="session" :player="voice"
                :user="state.user" :server-url="state.serverUrl" :copy-text="copyText" :can-read-users="feature('staff')" @saved="voice.stop()" />
            </template>
            <template #update>
              <NativeUpdate v-if="!standalone" :api="updateApi" :origin="state.serverUrl" :can-check="state.online" :check-update="updateCheck.checkManually"
                :before-install="beforeInstall" :available-update="updateCheck.availableUpdate.value" :update-resume-token="foregroundToken"
                :auto-start-download="autoStartDownload" @auto-start-consumed="autoStartDownload = false" />
            </template>
          </RelationalWorkbench>
        </div>
      </template>
      <ConfirmModal :modal="confirmation" @cancel="finishConfirm(false)" @accept="finishConfirm(true)" />
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { App as CapacitorApp } from '@capacitor/app';
import { Bell } from 'lucide-vue-next';
import { createRelationalNativeSession, cloudDeviceBridge } from './relational-native-session.js';
import { createNativeWorkspace } from './relational-native-workspace.js';
import { createNativeArchiveController } from './relational-native-files.js';
import { createNativeUpdate } from './native-update.js';
import { DEFAULT_CLOUD_SERVER_URL } from './cloud-config.js';
import { allowsFeature } from './license-policy.js';
import { announceRelationalSale, businessDays, displayCents, todayBusiness } from './relational-presentation.js';
import { useNotices } from './composables/useNotices.js';
import { useAppUpdate } from './composables/useAppUpdate.js';
import { systemNotices } from './notices.js';
import { VoicePlayer } from './voice-player.js';
import AppHeader from './components/AppHeader.vue';
import ConfirmModal from './components/ConfirmModal.vue';
import NativeUpdate from './components/NativeUpdate.vue';
import NoticeCenter from './components/NoticeCenter.vue';
import NoticeTicker from './components/NoticeTicker.vue';
import OfflineActivation from './components/OfflineActivation.vue';
import RelationalNativeSync from './components/RelationalNativeSync.vue';
import RelationalWorkbench from './components/RelationalWorkbench.vue';
import StoreSettings from './components/StoreSettings.vue';
import VoiceSettings from './components/VoiceSettings.vue';
import PasswordField from './components/PasswordField.vue';
import { useModalLayers } from './composables/useModalLayers.js';

const session = createRelationalNativeSession(), state = session.state;
const workspace = createNativeWorkspace(session), archive = createNativeArchiveController(workspace), updateApi = createNativeUpdate(session);
const standalone = computed(() => state.binding?.mode === 'standalone');
const connectionLabel = computed(() => state.user ? state.user.displayName + ' · ' +
  (!state.deviceAccess.allowed ? '授权待核验' : standalone.value ? '独立离线' : state.online ? '云端已连接' : '离线可用') : standalone.value ? '本地账号' : '门店账号');
const unlocked = computed(() => Boolean(state.user && state.deviceAccess.allowed));
const owner = computed(() => state.user?.role === 'owner');
const canWrite = computed(() => unlocked.value && state.user?.role !== 'viewer' && workspace.state.replicaReady && !workspace.state.blockedEpoch && !state.busy);
const identity = computed(() => JSON.stringify([state.user?.storeId, state.user?.id, state.generation]));
const feature = name => allowsFeature(state.deviceAccess.features, name);
const copyText = text => cloudDeviceBridge.copyText({ text });
const workbench = ref(null), noticesOpen = ref(false), message = ref('');
const headerSearchQuery = ref(''), headerCustomerFilter = ref('all'), headerFilterOpen = ref(false);
const accountBusy = ref(false), origin = ref(DEFAULT_CLOUD_SERVER_URL), username = ref(''), password = ref('');
const foregroundToken = ref(0), autoStartDownload = ref(false), confirmation = shallowRef(null);
useModalLayers({ onEscape: () => { if (closeTop()) backCount = 0; } });
const voice = new VoicePlayer({ api: session, context: () => identity.value,
  canBroadcast: () => unlocked.value && !standalone.value && state.online && feature('voice') });
const announce = (...values) => { if (voice.canBroadcast()) return announceRelationalSale(voice, ...values); };
const updateCheck = useAppUpdate({ state: computed(() => state), ready: computed(() => state.ready && !standalone.value), isNativeApp: true,
  canPrompt: computed(() => unlocked.value && !workspace.state.busy && !noticesOpen.value && !workbench.value?.hasOpenAction), check: updateApi.check,
  askConfirm: settings => new Promise(resolve => { finishConfirm(false); confirmation.value = { ...settings, resolve }; }),
  onUpdate: () => openUpdate() });

const noticeState = computed(() => ({ ...state, locked: !unlocked.value,
  status: workspace.state.blockedEpoch || workspace.state.syncStatus === 'conflict' ? 'conflict' : '',
  pendingCount: workspace.state.pendingCount, syncStatus: workspace.state.syncStatus }));
const balances = shallowRef(null);
const systemItems = computed(() => systemNotices({ state: noticeState.value, storageError: workspace.state.error,
  relationalBalances: balances.value, debtVersion: JSON.stringify([workspace.state.book?.ledgerEpoch, balances.value?.debtCount, balances.value?.debtCents]),
  availableUpdate: updateCheck.availableUpdate.value }));
const notices = useNotices({ state: noticeState, systemItems, ledgerReady: computed(() => Boolean(balances.value)) });
watch([identity, unlocked], () => { voice.stop(); password.value = ''; balances.value = null; noticesOpen.value = false; finishConfirm(false); });
watch(identity, () => { headerSearchQuery.value = ''; headerCustomerFilter.value = 'all'; headerFilterOpen.value = false; });
watch(() => [workspace.state.revision, identity.value, unlocked.value, feature('reports')], async (_, _old, onCleanup) => {
  if (!unlocked.value || !workspace.state.replicaReady || !feature('reports')) return;
  let live = true; onCleanup(() => { live = false; });
  const day = todayBusiness();
  try { const report = await workspace.read('reportBusiness', businessDays(day, day)); if (live) balances.value = report.balances; } catch {}
});
function noticeReceipt(item, action) { try { notices.act(item, action); } catch { message.value = '本机未能保存提醒状态'; } }
function noticeAction(action) {
  noticesOpen.value = false;
  if (action === 'update') openUpdate();
  else if (action === 'debt') workbench.value?.openMembers('debt');
  else if (action === 'backup-files' && standalone.value) workbench.value?.openBackup();
  else workbench.value?.openAccount();
}
function finishConfirm(accept) { const ask = confirmation.value; confirmation.value = null; ask?.resolve(accept); }
function openUpdate() { workbench.value?.openUpdate(); autoStartDownload.value = true; }
function openNewMember() { workbench.value?.openCreateMember(); }
async function refreshSearch() { await nextTick(); workbench.value?.search(); }
async function clearSearch() { headerSearchQuery.value = ''; await refreshSearch(); }
async function beforeInstall() {
  if (!unlocked.value || standalone.value || workspace.state.status !== 'ready' || workspace.state.busy) throw new Error('请先打开账本并完成当前操作');
  if (workspace.state.pendingCount && state.online) await workspace.sync();
  if (!unlocked.value || workspace.state.pendingCount || workspace.state.pending || workspace.state.pendingError || workspace.state.blockedEpoch) {
    throw new Error('请先核对账本和原待办，再安装更新');
  }
}
async function account(action) {
  if (accountBusy.value) return;
  accountBusy.value = true; message.value = '';
  try { await action(); } catch (error) { message.value = error.message; }
  finally { accountBusy.value = false; password.value = ''; }
}
function signIn() { return account(() => standalone.value ? session.loginOffline(username.value, password.value) : session.login(origin.value, username.value, password.value)); }
function signOut() { if (!state.busy && !workspace.state.busy) return account(session.logout); }
async function copyDevice() { try { await copyText(state.deviceId); message.value = '设备标识已复制'; } catch (error) { message.value = error.message; } }

let live = true, timer, reconnecting, backCount = 0, backAt = 0;
const detach = [];
async function resume() {
  if (reconnecting) return reconnecting;
  reconnecting = (async () => {
    if (!live) return;
    session.publishAccess();
    try { await session.heartbeat(); } catch {}
    if (!live) return;
    try {
      if (unlocked.value && !workspace.state.book && workspace.state.status !== 'loading') await workspace.connect();
      await workspace.sync();
    } catch {}
  })().finally(() => { reconnecting = null; });
  return reconnecting;
}
async function start() {
  try {
    await session.init(); if (!live) return;
    origin.value = state.serverUrl || DEFAULT_CLOUD_SERVER_URL;
    username.value = state.deviceAccess.localUsername || state.user?.username || '';
    await resume();
  } catch (error) { message.value = error.message; }
}
function onOffline() { void session.heartbeat().catch(() => {}); voice.stop(); }
function onForeground() { foregroundToken.value++; void resume().then(updateCheck.checkOnOpen); }
function closeTop() {
  if (confirmation.value) { finishConfirm(false); return true; }
  if (noticesOpen.value) { noticesOpen.value = false; return true; }
  return workbench.value?.goHome() ?? false;
}
function onKeyDown(event) {
  if (event.key === 'Escape' && closeTop()) { event.preventDefault(); backCount = 0; }
}
async function onBack() {
  if (closeTop()) { backCount = 0; return; }
  if (Date.now() - backAt > 2000) backCount = 0;
  backAt = Date.now(); backCount++;
  if (backCount >= 3) { backCount = 0; try { await CapacitorApp.exitApp(); } catch (error) { message.value = error.message; } }
  else message.value = backCount === 1 ? '再按两次返回键退出应用' : '再按一次返回键退出应用';
}
function listen(event, handler) {
  void CapacitorApp.addListener(event, handler).then(listener => { if (live) detach.push(listener); else return listener.remove(); }).catch(() => {});
}
onMounted(() => {
  window.addEventListener('online', resume); window.addEventListener('offline', onOffline);
  window.addEventListener('keydown', onKeyDown);
  listen('backButton', onBack);
  listen('appStateChange', ({ isActive }) => {
    if (isActive) onForeground();
    else { updateCheck.onBackground(); voice.stop(); void session.checkpoint().catch(() => {}); }
  });
  timer = setInterval(() => { if (document.visibilityState !== 'hidden') void resume(); }, 30000);
  void start();
});
onUnmounted(() => {
  live = false; finishConfirm(false); voice.stop(); clearInterval(timer);
  window.removeEventListener('online', resume); window.removeEventListener('offline', onOffline);
  window.removeEventListener('keydown', onKeyDown);
  for (const listener of detach) void listener.remove();
  void workspace.dispose().catch(() => {});
});
</script>
