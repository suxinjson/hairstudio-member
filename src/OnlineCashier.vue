<template>
  <div class="app-shell flex flex-col min-h-screen bg-slate-100/90 text-slate-900 select-none pb-28 max-w-full overflow-x-hidden">
    <!-- 现代化黑金/深空灰全宽贴顶状态栏与品牌头 -->
    <header class="app-header w-full bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900/98 text-white px-3.5 py-3 sm:px-6 sticky top-0 z-30 shadow-md border-b border-slate-800">
      <div class="max-w-4xl mx-auto flex items-center justify-between gap-2.5">
        <div class="flex items-center gap-2.5 min-w-0 flex-1">
          <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center font-black text-lg shadow-md shrink-0" aria-hidden="true">
            💳
          </div>
          <div class="min-w-0 flex-1">
            <h1 class="text-base font-black text-white tracking-tight m-0 truncate leading-tight">会员管家</h1>
            <p v-if="user && !locked" class="m-0 text-xs text-slate-300 font-medium flex items-center gap-1.5 mt-0.5 truncate">
              <span class="w-2 h-2 rounded-full shrink-0 bg-emerald-400 animate-pulse"></span>
              <span class="truncate">{{ adminApi.storeProfile.value.name }} · {{ user.displayName }}</span>
            </p>
          </div>
        </div>
        <div v-if="user && !locked" class="flex items-center gap-2 shrink-0">
          <button
            v-if="writable && workspace.state.book"
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
      </div>
    </header>

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
        :feature="feature" :identity="identity" :announce="announce" :backup="archive">
        <div class="book-panel book-stack">
          <h2>账号与设置</h2><p>当前账号 {{ user.displayName }}。网页版在线读写门店账本。</p>
          <a href="/admin/">打开商家后台管理设备、员工和设置</a>
        </div>
        <StoreSettingsView v-if="feature('settings')" />
        <VoiceSettingsView v-if="feature('voice') && owner" />
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
