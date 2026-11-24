<template>
  <div class="book-cashier book-stack">
    <header class="book-panel book-actions book-between">
      <div><h1>会员管家 · 网页收银</h1><p v-if="user && !locked">{{ adminApi.storeProfile.value.name }} · {{ user.displayName }}</p></div>
      <div v-if="user && !locked" class="book-actions">
        <button type="button" @click="locked = true">锁屏</button>
        <button type="button" :disabled="busy" @click="signOut">退出</button>
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
