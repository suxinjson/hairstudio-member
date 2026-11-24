<template>
  <div class="book-cashier book-stack">
    <!-- 现代化黑金/深空灰渐变状态栏与顶部品牌头 -->
    <header class="app-header bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900/98 text-white rounded-2xl p-3.5 sm:p-4 shadow-lg border border-slate-800 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center font-black text-xl shadow-md shrink-0" aria-hidden="true">
          💳
        </div>
        <div class="min-w-0">
          <h1 class="text-base sm:text-lg font-black text-white tracking-tight m-0 truncate">会员管家 · 网页收银</h1>
          <p v-if="user && !locked" class="m-0 text-xs text-slate-300 font-medium flex items-center gap-1.5 mt-0.5 truncate">
            <span class="w-2 h-2 rounded-full shrink-0 bg-emerald-400 animate-pulse"></span>
            <span class="truncate">{{ adminApi.storeProfile.value.name }} · {{ user.displayName }}</span>
          </p>
        </div>
      </div>
      <div v-if="user && !locked" class="flex items-center gap-2 shrink-0">
        <button type="button" class="h-9 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 btn-press" @click="locked = true">
          锁屏
        </button>
        <button type="button" class="h-9 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 btn-press" :disabled="busy" @click="signOut">
          退出
        </button>
      </div>
    </header>
    <p v-if="notice" class="book-panel book-alert" role="alert">{{ notice }}</p>
    <form v-if="!user || locked" class="book-panel book-stack" @submit.prevent="signIn">
      <h2>{{ locked ? '收银工作台已锁屏' : '登录门店账号' }}</h2>
      <label v-if="!locked">登录账号<input v-model.trim="username" autocomplete="username" required></label>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" required></label>
      <p v-if="locked">当前账号 {{ user.displayName }}</p>
      <div class="book-actions">
        <button class="book-primary" type="submit" :disabled="busy">{{ locked ? '解锁' : '登录' }}</button>
        <button v-if="locked" type="button" :disabled="busy" @click="signOut">切换账号</button>
      </div>
    </form>
    <RelationalWorkbench v-else :workspace="workspace" :owner="owner" :writable="writable" :profile-writable="writable"
      :feature="feature" :identity="identity" :announce="announce" :backup="archive">
      <div class="book-panel book-stack">
        <h2>账号与设置</h2><p>当前账号 {{ user.displayName }}。网页版在线读写门店账本。</p>
        <a href="/admin/">打开商家后台管理设备、员工和设置</a>
      </div>
      <StoreSettingsView v-if="feature('settings')" />
      <VoiceSettingsView v-if="feature('voice') && owner" />
    </RelationalWorkbench>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { adminApi } from '../admin/src/api/session.js';
import { voicePlayer } from '../admin/src/utils/voice-player.js';
import { useAutoLock } from '../admin/src/utils/security.js';
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
const username = ref(''), password = ref(''), notice = ref(''), busy = ref(false);
const announce = (...args) => { if (feature('voice')) return announceRelationalSale(voicePlayer, ...args); };
useAutoLock(adminApi);
watch([identity, locked], () => { password.value = ''; notice.value = ''; voicePlayer.stop(); }, { flush: 'sync' });
onMounted(() => { if (user.value && !locked.value) void workspace.connect(); });
onUnmounted(() => { voicePlayer.stop(); workspace.dispose(); });
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
