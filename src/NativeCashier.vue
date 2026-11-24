<template>
  <div class="book-cashier book-stack">
    <!-- 现代化黑金/深空灰渐变状态栏与顶部品牌头 -->
    <header class="app-header bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900/98 text-white rounded-2xl p-3.5 sm:p-4 shadow-lg border border-slate-800 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center font-black text-xl shadow-md shrink-0" aria-hidden="true">
          💳
        </div>
        <div class="min-w-0">
          <h1 class="text-base sm:text-lg font-black text-white tracking-tight m-0 truncate">会员管家</h1>
          <p v-if="unlocked" class="m-0 text-xs text-slate-300 font-medium flex items-center gap-1.5 mt-0.5 truncate">
            <span class="w-2 h-2 rounded-full shrink-0" :class="state.online ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'"></span>
            <span class="truncate">{{ state.storeProfile.name }} · {{ state.user.displayName }}</span>
          </p>
        </div>
      </div>
      <div v-if="unlocked" class="flex items-center gap-2 shrink-0">
        <button type="button" aria-label="提醒中心" class="relative w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center border border-slate-700 btn-press" @click="noticesOpen = !noticesOpen">
          <Bell :size="18" aria-hidden="true" />
          <span v-if="notices.headerItems.value.length" class="absolute -top-1 -right-1 px-1.5 py-0.2 bg-rose-600 text-white text-[10px] font-black rounded-full shadow-xs">
            {{ notices.headerItems.value.length }}
          </span>
        </button>
        <button
          v-if="canWrite"
          type="button"
          aria-label="新增会员"
          :disabled="workspace.state.busy || workspace.state.pending || !workspace.state.book"
          class="register-member h-9 px-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 active:from-emerald-700 text-white text-xs font-black rounded-xl shadow-md shadow-emerald-950/40 flex items-center gap-1 btn-press transition-all shrink-0"
          @click="openNewMember"
        >
          <span class="text-sm font-black leading-none">+</span>
          <span>登记会员</span>
        </button>
      </div>
    </header>
    <p v-if="message || state.error" class="book-panel book-alert" role="alert">{{ message || state.error }}</p>
    <div v-if="!state.ready" class="book-panel book-stack">
      <p role="status">正在读取设备授权…</p><button v-if="state.error" type="button" @click="start">重试</button>
    </div>
    <template v-else-if="!unlocked">
      <form v-if="!state.user" class="book-panel book-stack" @submit.prevent="signIn">
        <h2>{{ standalone ? '登录本地账号' : '登录门店账号' }}</h2>
        <label v-if="!standalone">服务器<input v-model.trim="origin" type="url" autocomplete="url" :readonly="Boolean(state.binding)" required></label>
        <label>账号<input v-model.trim="username" autocomplete="username" autocapitalize="none" required></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" required></label>
        <button class="book-primary" type="submit" :disabled="accountBusy || state.busy">登录</button>
      </form>
      <div v-else class="book-panel book-stack">
        <p role="status">{{ state.deviceAccess.reason }}</p>
        <button type="button" :disabled="accountBusy || state.busy" @click="resume">重新核验使用授权</button>
        <button type="button" :disabled="accountBusy || state.busy" @click="signOut">退出并重新登录</button>
      </div>
      <div v-if="state.binding?.mode !== 'cloud' && !state.user" class="book-panel">
        <OfflineActivation :state="state" :activate-offline="session.activateOffline" :copy-text="copyText" />
      </div>
    </template>
    <template v-else>
      <NoticeCenter v-if="noticesOpen" :items="notices.items.value" @back="noticesOpen = false" @navigate="noticeAction" @act="noticeReceipt" />
      <NoticeTicker v-else :items="notices.headerItems.value" @open="noticesOpen = true" />
      <div v-show="!noticesOpen" class="book-stack">
        <RelationalWorkbench ref="workbench" :workspace="workspace" :identity="identity" :owner="owner" :writable="canWrite"
          :profile-writable="canWrite && (standalone || state.online)" :feature="feature" :announce="announce" :backup="standalone ? archive : null">
          <template #connection>
            <RelationalNativeSync v-if="workspace.state.book && !standalone" :workspace="workspace" :online="state.online" :owner="owner" @reconnect="resume" />
          </template>
          <section class="book-panel book-stack">
            <h3>账号与设备</h3>
            <p>{{ standalone ? '独立离线账本' : '云端绑定 · 本机 SQLite' }} · {{ state.user.displayName }}</p>
            <label>设备标识<input :value="state.deviceId" readonly></label>
            <button type="button" @click="copyDevice">复制设备标识</button>
            <p v-if="state.deviceAccess.authorizedUntil">授权到期 {{ new Date(state.deviceAccess.authorizedUntil).toLocaleString() }}</p>
            <a v-if="!standalone && state.online" :href="state.serverUrl + '/admin/'" target="_blank" rel="noopener noreferrer">商家后台 · 员工、设备、审计和云端备份</a>
          </section>
          <StoreSettings v-if="feature('settings')" :profile="state.storeProfile" :can-edit="owner && !standalone && state.online"
            :load-profile="standalone ? undefined : session.loadStoreProfile" :save-profile="session.saveStoreProfile" />
          <VoiceSettings v-if="feature('voice') && !standalone && state.online" :api="session" :player="voice"
            :user="state.user" :server-url="state.serverUrl" :copy-text="copyText" @saved="voice.stop()" />
          <NativeUpdate v-if="!standalone" :api="updateApi" :origin="state.serverUrl" :can-check="state.online" :check-update="updateCheck.checkManually"
            :before-install="beforeInstall" :available-update="updateCheck.availableUpdate.value" :update-resume-token="foregroundToken"
            :auto-start-download="autoStartDownload" @auto-start-consumed="autoStartDownload = false" />
        </RelationalWorkbench>
      </div>
    </template>
    <ConfirmModal :modal="confirmation" @cancel="finishConfirm(false)" @accept="finishConfirm(true)" />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
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
import ConfirmModal from './components/ConfirmModal.vue';
import NativeUpdate from './components/NativeUpdate.vue';
import NoticeCenter from './components/NoticeCenter.vue';
import NoticeTicker from './components/NoticeTicker.vue';
import OfflineActivation from './components/OfflineActivation.vue';
import RelationalNativeSync from './components/RelationalNativeSync.vue';
import RelationalWorkbench from './components/RelationalWorkbench.vue';
import StoreSettings from './components/StoreSettings.vue';
import VoiceSettings from './components/VoiceSettings.vue';

const session = createRelationalNativeSession(), state = session.state;
const workspace = createNativeWorkspace(session), archive = createNativeArchiveController(workspace), updateApi = createNativeUpdate(session);
const standalone = computed(() => state.binding?.mode === 'standalone');
const unlocked = computed(() => Boolean(state.user && (!state.deviceAccess.disabled || state.deviceAccess.allowed)));
const owner = computed(() => state.user?.role === 'owner');
const canWrite = computed(() => state.user?.role !== 'viewer' && workspace.state.replicaReady && !workspace.state.blockedEpoch && !state.busy);
const identity = computed(() => JSON.stringify([state.user?.storeId, state.user?.id, state.generation]));
const feature = name => allowsFeature(state.deviceAccess.features, name);
const copyText = text => cloudDeviceBridge.copyText({ text });
const workbench = ref(null), noticesOpen = ref(false), message = ref('');
const accountBusy = ref(false), origin = ref(DEFAULT_CLOUD_SERVER_URL), username = ref(''), password = ref('');
const foregroundToken = ref(0), autoStartDownload = ref(false), confirmation = shallowRef(null);
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
function openUpdate() { workbench.value?.openAccount(); autoStartDownload.value = true; }
function openNewMember() { workbench.value?.openCreateMember(); }
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
function signOut() { return account(session.logout); }
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
