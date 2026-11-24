<template>
  <!-- 未登录状态：展示安全登录屏 -->
  <LoginView v-if="!currentUser" />

  <!-- 已登录状态：展示全功能大屏 PC 管理系统 -->
  <div v-else class="flex h-screen bg-slate-100/90 text-slate-800 overflow-hidden font-sans select-text">
    <!-- 左侧主侧边栏 -->
    <aside class="w-64 bg-slate-900 text-white flex flex-col justify-between shrink-0 shadow-xl z-20">
      <div>
        <!-- 品牌标识 -->
        <div class="h-16 px-5 flex items-center gap-3 border-b border-slate-800">
          <span class="text-2xl">💳</span>
          <div>
            <h1 class="font-black text-sm tracking-tight text-white">会员管家</h1>
            <span class="text-[10px] text-emerald-400 font-bold bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-800">商家经营后台 · 仅当前门店</span>
          </div>
        </div>

        <!-- 导航菜单 -->
        <nav class="p-3 space-y-1.5" aria-label="管理后台主菜单">
          <button
            v-for="item in navItems"
            :key="item.key"
            :aria-label="item.label"
            :aria-current="activeTab === item.key ? 'page' : undefined"
            @click="activeTab = item.key"
            class="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl font-bold text-xs transition btn-press"
            :class="activeTab === item.key ? 'bg-emerald-700 text-white shadow-md shadow-emerald-900/40' : 'text-slate-400 hover:text-white hover:bg-slate-800/80'"
          >
            <div class="flex items-center gap-2.5">
              <span class="text-base" aria-hidden="true">{{ item.icon }}</span>
              <span>{{ item.label }}</span>
            </div>
            <span
              v-if="item.badge"
              class="px-1.5 py-0.5 text-[10px] font-black rounded-full"
              :class="activeTab === item.key ? 'bg-white text-emerald-900' : 'bg-emerald-900/80 text-emerald-300'"
            >
              {{ item.badge }}
            </span>
          </button>
        </nav>
      </div>

      <!-- 底部当前登录账号卡片 -->
      <div class="p-3 border-t border-slate-800">
        <div class="p-3 rounded-2xl bg-slate-800/80 border border-slate-700/60 flex items-center justify-between">
          <div class="min-w-0 flex-1">
            <div class="text-xs font-black text-white truncate">{{ currentUser.displayName }}</div>
            <div class="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1">
              <span class="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              <span>{{ currentUser.role === 'owner' ? '店主 (主管理员)' : currentUser.role === 'clerk' ? '收银员/店员' : '外部审计员' }}</span>
            </div>
          </div>
          <button
            @click="triggerLock"
            class="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-700 transition"
            title="一键安全锁屏"
          >
            🔒
          </button>
        </div>
      </div>
    </aside>

    <!-- 右侧主体内容工作区 -->
    <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
      <!-- 顶栏状态指示栏 -->
      <header class="h-16 bg-white border-b border-slate-200/80 px-6 flex items-center justify-between shrink-0 shadow-sm z-10">
        <!-- 左侧标题与路径 -->
        <div class="flex items-center gap-3">
          <h2 class="text-lg font-black text-slate-900">
            {{ currentNavLabel }}
          </h2>
          <span class="text-xs text-slate-400">· {{ adminApi.storeProfile.value.name }}</span>
        </div>

        <!-- 右侧连接状态与快捷功能 -->
        <div class="flex items-center gap-3">
          <div role="status" class="text-xs text-emerald-800">{{ syncLabel }}</div>
          <button @click="workspace.connect" :disabled="workspace.state.status === 'loading' || workspace.state.busy || isLocked"
            class="h-9 px-3 bg-slate-100 rounded-xl text-xs font-bold" title="重新连接账本">刷新</button>

          <!-- 退出登录 -->
          <button
            @click="handleLogout"
            class="h-9 px-3 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-bold transition flex items-center gap-1"
            title="安全退出系统"
          >
            <span>🚪</span> 退出
          </button>
        </div>
      </header>

      <main v-if="!isLocked" :key="bookKey" class="flex-1 overflow-y-auto p-6 book-stack" style="align-content: start">
        <RelationalPending v-if="workspace.state.book" :workspace="workspace" />
        <template v-if="businessTabs.has(activeTab)">
          <div v-if="!workspace.state.book" class="book-panel book-stack">
            <p :role="workspace.state.error ? 'alert' : 'status'">{{ workspace.state.error || '正在连接当前门店账本…' }}</p>
            <button v-if="workspace.state.status !== 'loading'" type="button" @click="workspace.connect()">重试连接</button>
          </div>
          <RelationalReports v-else-if="activeTab === 'dashboard'" :workspace="workspace" />
          <RelationalMembers v-else-if="activeTab === 'members'" :workspace="workspace" :owner="owner" :writable="writable" :feature="feature" :announce="announce" @history="openHistory" />
          <RelationalLedger v-else-if="activeTab === 'ledgers'" :workspace="workspace" :owner="owner" :member-id="history.id" :member-name="history.name" @all-members="history = {}" />
          <RelationalConfiguration v-else-if="activeTab === 'services'" :workspace="workspace" :owner="owner" />
          <RelationalBatches v-else-if="activeTab === 'batches'" :workspace="workspace" :writable="writable" />
          <RelationalExportView v-else-if="activeTab === 'export' && owner" :workspace="workspace" :feature="feature" :jobs="exportJobs" />
          <RelationalBackup v-else-if="activeTab === 'backup' && owner" :workspace="workspace" :controller="archive" />
        </template>

        <VoiceSettingsView
          v-else-if="activeTab === 'voice'"
        />

        <UsersView
          v-else-if="activeTab === 'users'"
        />
        <DevicesView v-else-if="activeTab === 'devices' && currentUser.role === 'owner'" />
        <StoreSettingsView v-else-if="activeTab === 'store'" />

        <AuditLogView
          v-else-if="activeTab === 'audit'"
        />
      </main>
    </div>

    <!-- 安全锁屏覆盖层 (空闲 15 分钟或手动锁屏触发) -->
    <div v-if="isLocked" class="admin-modal-backdrop fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-6 select-none">
      <div class="admin-modal-surface bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl text-center border border-slate-200">
        <div class="w-16 h-16 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center text-3xl mx-auto mb-3 shadow-inner">
          🔒
        </div>
        <h3 class="text-xl font-black text-slate-900">系统已安全锁屏</h3>
        <p class="text-xs text-slate-400 mt-1 mb-6">长时间未操作自动保护客户隐私与账户资金</p>

        <div class="text-left mb-4">
          <label class="block text-xs font-bold text-slate-600 mb-1">输入密码以解锁 (当前账号: {{ currentUser.displayName }})</label>
          <input
            v-model="unlockPassword"
            type="password"
            placeholder="请输入您的登录密码"
            class="w-full h-11 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold focus:outline-none focus:border-emerald-600"
            @keyup.enter="handleUnlock"
          />
        </div>

        <div v-if="unlockError" class="mb-4 text-xs font-bold text-rose-600">
          {{ unlockError }}
        </div>

        <div class="flex gap-2">
          <button
            @click="handleLogout"
            class="flex-1 h-11 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition"
          >
            切换账号
          </button>
          <button
            @click="handleUnlock"
            :disabled="!unlockPassword || isUnlocking"
            class="flex-1 h-11 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black transition disabled:opacity-50"
          >
            {{ isUnlocking ? '验证中...' : '解锁工作台' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { adminApi } from './api/session.js';
import { voicePlayer } from './utils/voice-player.js';
import { useAutoLock } from './utils/security.js';
import LoginView from './views/LoginView.vue';
import RelationalMembers from '../../src/components/RelationalMembers.vue';
import RelationalLedger from '../../src/components/RelationalLedger.vue';
import RelationalReports from '../../src/components/RelationalReports.vue';
import RelationalConfiguration from '../../src/components/RelationalConfiguration.vue';
import RelationalPending from '../../src/components/RelationalPending.vue';
import RelationalBatches from '../../src/components/RelationalBatches.vue';
import RelationalBackup from '../../src/components/RelationalBackup.vue';
import RelationalExportView from './views/RelationalExportView.vue';
import { createLedgerExportClient } from './utils/ledger-export-jobs.js';
import { createOnlineWorkspace } from '../../src/relational-online-workspace.js';
import { createServerArchiveFiles } from '../../src/relational-server-files.js';
import { announceRelationalSale } from '../../src/relational-presentation.js';
import VoiceSettingsView from './views/VoiceSettingsView.vue';
import UsersView from './views/UsersView.vue';
import DevicesView from './views/DevicesView.vue';
import StoreSettingsView from './views/StoreSettingsView.vue';
import AuditLogView from './views/AuditLogView.vue';
import { allowsFeature } from '../../src/license-policy.js';

const currentUser = computed(() => adminApi.user.value);
const workspace = createOnlineWorkspace(adminApi);
const archive = createServerArchiveFiles({ workspace, api: adminApi });
const exportJobs = createLedgerExportClient({ workspace, api: adminApi });
watch([() => currentUser.value?.storeId, () => currentUser.value?.id, () => currentUser.value?.role, adminApi.isLocked],
  () => voicePlayer.stop(), { flush: 'sync' });
onUnmounted(() => { voicePlayer.stop(); workspace.dispose(); });
const activeTab = ref('dashboard');
const businessTabs = new Set(['dashboard', 'members', 'ledgers', 'services', 'batches', 'export', 'backup']);
const history = ref({});
const owner = computed(() => currentUser.value?.role === 'owner');
const writable = computed(() => Boolean(currentUser.value && currentUser.value.role !== 'viewer'));
const feature = name => !adminApi.entitlements.value || allowsFeature(adminApi.entitlements.value.features, name);
const bookKey = computed(() => [currentUser.value?.storeId, currentUser.value?.id, currentUser.value?.role, workspace.state.book?.ledgerEpoch].join(':'));
const syncLabel = computed(() => workspace.state.pending ? '有一笔操作待确认' : ({ idle: '账本待连接', loading: '正在连接', ready: '在线账本', error: '账本连接失败' }[workspace.state.status]));
watch(bookKey, () => { history.value = {}; });
function openHistory(id, name) { history.value = { id, name }; activeTab.value = 'ledgers'; }
function announce(result, draft, member) {
  if (feature('voice')) return announceRelationalSale(voicePlayer, result, draft, member);
}

const isLocked = adminApi.isLocked;
const unlockPassword = ref('');
const unlockError = ref('');
const isUnlocking = ref(false);
watch(() => currentUser.value?.storeId + ':' + currentUser.value?.id, () => {
  activeTab.value = navItems.value[0]?.key || 'dashboard'; history.value = {}; unlockPassword.value = ''; unlockError.value = '';
}, { flush: 'post' });

const navItems = computed(() => [
  { key: 'dashboard', label: '经营大盘', icon: '📊' },
  { key: 'members', label: '会员档案', icon: '👥' },
  { key: 'ledgers', label: '财务流水', icon: '📑' },
  { key: 'batches', label: '批量资料', icon: '📥' },
  ...(owner.value ? [{ key: 'export', label: '表格导出', icon: '📤' }, { key: 'backup', label: '备份与恢复', icon: '📁' }] : []),
  { key: 'services', label: '服务与卡项', icon: '💇' },
  { key: 'store', label: '门店设置', icon: '🏪' },
  { key: 'voice', label: '语音播报', icon: '📢' },
  { key: 'users', label: '员工权限', icon: '🛡️' },
  ...(currentUser.value?.role === 'owner' ? [{ key: 'devices', label: '设备授权', icon: '📱' }] : []),
  { key: 'audit', label: '安全审计', icon: '🔍' }
].filter(item => {
  const requirement = { dashboard: 'reports', ledgers: 'cashier', services: 'settings', store: 'settings', voice: 'voice', users: 'staff', devices: 'devices', members: 'members', batches: 'members', backup: 'backup' }[item.key];
  return !requirement || feature(requirement);
}));
watch(navItems, items => { if (!items.some(item => item.key === activeTab.value)) activeTab.value = items[0]?.key || 'dashboard'; });

const currentNavLabel = computed(() => {
  return navItems.value.find(i => i.key === activeTab.value)?.label || '工作台';
});

// 注册 15 分钟无操作自动锁屏
useAutoLock(adminApi);
watch(isLocked, locked => {
  if (locked) { unlockPassword.value = ''; unlockError.value = ''; }
});

function triggerLock() {
  isLocked.value = true;
  unlockPassword.value = '';
  unlockError.value = '';
}

async function handleUnlock() {
  if (!unlockPassword.value) return;
  isUnlocking.value = true;
  unlockError.value = '';
  try {
    // 重新校验密码
    await adminApi.login(currentUser.value.username, unlockPassword.value);
    isLocked.value = false;
    unlockPassword.value = '';
  } catch (err) {
    unlockError.value = '密码错误，请重新输入';
  } finally {
    isUnlocking.value = false;
  }
}

async function handleLogout() {
  if (!confirm('确定要退出登录吗？')) return;
  try { await adminApi.logout(); }
  catch (error) { alert('本机已退出，云端会话撤销未完成：' + error.message); }
}

onMounted(() => {
  if (!navItems.value.some(item => item.key === activeTab.value)) activeTab.value = navItems.value[0]?.key || 'dashboard';
  if (currentUser.value && !isLocked.value) void workspace.connect();
});
</script>
