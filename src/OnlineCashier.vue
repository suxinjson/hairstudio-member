<template>
  <div class="app-shell flex flex-col min-h-screen bg-slate-100/90 text-slate-900 select-none pb-28 max-w-full overflow-x-hidden">
    <!-- 顶部状态栏与大搜索框 (AppHeader 经典复刻) -->
    <AppHeader
      :active-tab="workbench?.activeTab || 'members'"
      v-model:customer-filter="headerCustomerFilter"
      v-model:filter-open="headerFilterOpen"
      :store-name="adminApi.storeProfile.value?.name || '我的门店'"
      :connection-label="user ? user.displayName + ' · 在线收银' : '门店账号'"
      :cloud-locked="!user || locked"
      :cloud-online="true"
      :has-storage-error="Boolean(workspace.state.error)"
      :can-create-member="writable && Boolean(workspace.state.book) && !workspace.state.busy && !workspace.state.pending"
      v-model:search-query="headerSearchQuery"
      @create-member="openNewMember"
      @clear-search="headerSearchQuery = ''"
    />

    <main class="w-full max-w-4xl mx-auto px-2.5 py-3 sm:px-4 sm:py-4 space-y-3.5 flex-1 min-w-0">
      <p v-if="notice" class="book-panel book-alert" role="alert">{{ notice }}</p>
      <form v-if="!user || locked" class="book-panel book-stack bg-white rounded-2xl p-4 sm:p-6 shadow-sm border border-slate-200" @submit.prevent="signIn">
        <h2>{{ locked ? '收银工作台已锁屏' : '登录门店账号' }}</h2>
        <label v-if="!locked">登录账号<input v-model.trim="username" autocomplete="username" required></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" required></label>
        <p v-if="locked">当前账号 {{ user.displayName }}</p>
        <div class="book-actions">
          <button class="book-primary" type="submit" :disabled="busy">{{ locked ? '解锁' : '登录' }}</button>
          <button v-if="locked" type="button" :disabled="busy" @click="signOut">切换账号</button>
        </div>
      </form>
      <RelationalWorkbench v-else ref="workbench" :workspace="workspace" :owner="owner" :writable="writable" :profile-writable="writable"
        :feature="feature" :identity="identity" :announce="announce" :backup="archive"
        v-model:search-query="headerSearchQuery" v-model:balance-filter="headerCustomerFilter">
        <template #account>
          <div class="bg-white border border-slate-200/90 rounded-2xl p-5 shadow-xs space-y-3">
            <div class="flex items-center justify-between">
              <div>
                <h2 class="text-base font-black text-slate-900 m-0">账号与连接</h2>
                <p class="text-xs text-slate-500 m-0 mt-0.5">当前登录账号：<strong class="text-slate-800">{{ user.displayName }}</strong>（{{ user.role === 'owner' ? '店主' : '收银员' }}）</p>
              </div>
              <button type="button" @click="adminApi.logout()" class="px-3 py-1.5 text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 rounded-xl btn-press">
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
        <template #voice>
          <VoiceSettingsView v-if="feature('voice') && owner" />
        </template>
      </RelationalWorkbench>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
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

const workspace = createOnlineWorkspace(adminApi), archive = createServerArchiveFiles({ workspace, api: adminApi });
const user = adminApi.user, locked = adminApi.isLocked;
const owner = computed(() => user.value?.role === 'owner'), writable = computed(() => Boolean(user.value && user.value.role !== 'viewer'));
const identity = computed(() => JSON.stringify([user.value?.storeId, user.value?.id, user.value?.role]));
const feature = name => !adminApi.entitlements.value || allowsFeature(adminApi.entitlements.value.features, name);
const username = ref(''), password = ref(''), notice = ref(''), busy = ref(false), workbench = ref(null);
const headerSearchQuery = ref(''), headerCustomerFilter = ref('all'), headerFilterOpen = ref(false);
const announce = (...args) => { if (feature('voice')) return announceRelationalSale(voicePlayer, ...args); };
function openNewMember() { workbench.value?.openCreateMember(); }
// 移动端收银免去后台切回强锁机制，全天免密码连续高效收银
const keepActive = () => {
  if (user.value) {
    if (locked.value) adminApi.setAutoLock(false);
    adminApi.recordActivity();
  }
};
watch([identity, locked], () => { password.value = ''; notice.value = ''; voicePlayer.stop(); }, { flush: 'sync' });
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
