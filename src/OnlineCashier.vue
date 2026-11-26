<template>
  <div class="app-shell flex flex-col min-h-screen bg-slate-100/90 text-slate-900 select-none max-w-full overflow-x-hidden">
    <!-- 顶部状态栏与大搜索框 (AppHeader 经典复刻) -->
    <AppHeader
      :active-tab="workbench?.activeTab || 'members'"
      :ledger-view="workbench?.ledgerView || 'summary'"
      :show-member-filter="false" :show-notices="false"
      :show-create-member="writable && feature('members')"
      v-model:customer-filter="headerCustomerFilter"
      v-model:filter-open="headerFilterOpen"
      :store-name="adminApi.storeProfile.value?.name || '我的门店'"
      :connection-label="user ? user.displayName + ' · 网页收银' : '门店账号'"
      :cloud-locked="!user || locked"
      :cloud-online="true"
      :has-storage-error="Boolean(workspace.state.error)"
      :can-create-member="writable && Boolean(workspace.state.book) && !workspace.state.busy && !workspace.state.pending && !workspace.state.pendingError"
      v-model:search-query="headerSearchQuery"
      @create-member="openNewMember"
      @clear-search="clearSearch"
      @search="refreshSearch"
    />

    <main class="cashier-content w-full max-w-4xl mx-auto space-y-3.5 flex-1 min-w-0">
      <p v-if="notice" class="book-panel book-alert" role="alert">{{ notice }}</p>
      <form v-if="!user || locked" class="book-panel book-stack bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-200" @submit.prevent="signIn">
        <h2>{{ locked ? '收银工作台已锁屏' : '登录门店账号' }}</h2>
        <label v-if="!locked">登录账号<input v-model.trim="username" autocomplete="username" required></label>
        <label>密码<PasswordField v-model="password" autocomplete="current-password" :disabled="busy" required /></label>
        <p v-if="locked">当前账号 {{ user.displayName }}</p>
        <div class="book-actions">
          <button class="book-primary" type="submit" :disabled="busy">{{ locked ? '解锁' : '登录' }}</button>
          <button v-if="locked" type="button" :disabled="busy" @click="signOut">切换账号</button>
        </div>
      </form>
      <RelationalWorkbench v-else ref="workbench" :workspace="workspace" :owner="owner" :writable="writable" :profile-writable="writable"
        :feature="feature" :identity="identity" :announce="announce" :backup="archive"
        :store-name="adminApi.storeProfile.value?.name || '我的门店'" :member-notes-label="adminApi.storeProfile.value?.memberNotesLabel" :connection-label="user.displayName + ' · 网页收银'" :online="true" :copy-text="copyText"
        v-model:search-query="headerSearchQuery" v-model:balance-filter="headerCustomerFilter">
        <template #account>
          <div class="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="text-base font-black text-slate-900 m-0">账号与连接</h2>
                <p class="text-xs text-slate-500 m-0 mt-0.5">当前登录账号：<strong class="text-slate-800">{{ user.displayName }}</strong>（{{ user.role === 'owner' ? '店主' : user.role === 'viewer' ? '只读账号' : '收银员' }}）</p>
              </div>
              <button type="button" @click="signOut" :disabled="busy || workspace.state.busy" class="px-3 py-1.5 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-xl btn-press">
                退出登录
              </button>
            </div>
            <p class="text-xs text-slate-600 m-0 pt-2 border-t border-slate-100">网页在线版实时连接云端数据库，数据自动持久化入库。</p>
            <div class="pt-2">
              <a href="/admin/" target="_blank" class="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 hover:text-emerald-800">
                打开电脑端商家管理后台（管理设备、员工与高级报表） ›
              </a>
            </div>
          </div>
        </template>
        <template #store>
          <StoreSettingsView v-if="feature('settings')" />
        </template>
        <template #voice="{ active: voiceActive }">
          <VoiceSettingsView v-if="feature('voice')" :active="voiceActive" />
        </template>
      </RelationalWorkbench>
    </main>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { adminApi } from '../admin/src/api/session.js';
import { voicePlayer } from '../admin/src/utils/voice-player.js';
import VoiceSettingsView from '../admin/src/views/VoiceSettingsView.vue';
import StoreSettingsView from '../admin/src/views/StoreSettingsView.vue';
import AppHeader from './components/AppHeader.vue';
import RelationalWorkbench from './components/RelationalWorkbench.vue';
import { createOnlineWorkspace } from './relational-online-workspace.js';
import { createServerArchiveFiles } from './relational-server-files.js';
import { allowsFeature } from './license-policy.js';
import { announceRelationalSale } from './relational-presentation.js';
import PasswordField from './components/PasswordField.vue';
import { useModalLayers } from './composables/useModalLayers.js';

const workspace = createOnlineWorkspace(adminApi), archive = createServerArchiveFiles({ workspace, api: adminApi });
const user = adminApi.user, locked = adminApi.isLocked;
const owner = computed(() => user.value?.role === 'owner'), writable = computed(() => Boolean(user.value && user.value.role !== 'viewer'));
const identity = computed(() => JSON.stringify([user.value?.storeId, user.value?.id, user.value?.role]));
const feature = name => !adminApi.entitlements.value || allowsFeature(adminApi.entitlements.value.features, name);
const username = ref(''), password = ref(''), notice = ref(''), busy = ref(false), workbench = ref(null);
const memberSearchQuery = ref(''), ledgerSearchQuery = ref('');
const headerSearchQuery = computed({ get: () => workbench.value?.activeTab === 'ledger' ? ledgerSearchQuery.value : memberSearchQuery.value, set: value => { if (workbench.value?.activeTab === 'ledger') ledgerSearchQuery.value = value; else memberSearchQuery.value = value; } });
const headerCustomerFilter = ref('all'), headerFilterOpen = ref(false);
useModalLayers({ onEscape: () => workbench.value?.goHome() });
const copyText = text => {
  if (!globalThis.navigator?.clipboard?.writeText) throw new Error('暂时无法复制，请使用可复制的文字核对。');
  return navigator.clipboard.writeText(text);
};
const announce = (...args) => { if (feature('voice')) return announceRelationalSale(voicePlayer, ...args); };
function openNewMember() { workbench.value?.openCreateMember(); }
async function refreshSearch() { await nextTick(); workbench.value?.search(); }
async function clearSearch() { headerSearchQuery.value = ''; await refreshSearch(); }
// Continuous cashier activity may pause the idle timer; a shared lock still
// requires the current account's password.
const keepActive = () => {
  if (user.value) adminApi.recordActivity();
};
watch([identity, locked], () => { password.value = ''; notice.value = ''; voicePlayer.stop(); }, { flush: 'sync' });
watch(identity, () => { memberSearchQuery.value = ''; ledgerSearchQuery.value = ''; headerCustomerFilter.value = 'all'; headerFilterOpen.value = false; });
onMounted(() => {
  adminApi.setAutoLock(false);
  window.addEventListener('focus', keepActive);
  document.addEventListener('visibilitychange', keepActive);
  window.addEventListener('touchstart', keepActive, { passive: true });
  if (user.value && !locked.value) void workspace.connect();
});
onUnmounted(() => {
  adminApi.setAutoLock(true);
  window.removeEventListener('focus', keepActive);
  document.removeEventListener('visibilitychange', keepActive);
  window.removeEventListener('touchstart', keepActive);
  voicePlayer.stop();
  workspace.dispose();
});
async function signIn() {
  if (busy.value || !password.value) return;
  busy.value = true; notice.value = '';
  try { await adminApi.login(locked.value ? user.value.username : username.value, password.value); }
  catch (error) { notice.value = error.message; }
  finally { busy.value = false; password.value = ''; }
}
async function signOut() {
  if (busy.value) return;
  busy.value = true; notice.value = '';
  try { await adminApi.logout(); }
  catch (error) { notice.value = '本机已退出，云端会话撤销未确认：' + error.message; }
  finally { busy.value = false; }
}
</script>
