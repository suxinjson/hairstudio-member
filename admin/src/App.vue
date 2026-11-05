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
          <span class="text-2xl">💈</span>
          <div>
            <h1 class="font-black text-sm tracking-tight text-white">梦飞空间会员管家</h1>
            <span class="text-[10px] text-emerald-400 font-bold bg-emerald-950/80 px-1.5 py-0.5 rounded border border-emerald-800">PC 后台管理系统</span>
          </div>
        </div>

        <!-- 导航菜单 -->
        <nav class="p-3 space-y-1.5" aria-label="管理后台主菜单">
          <button
            v-for="item in navItems"
            :key="item.key"
            @click="activeTab = item.key"
            class="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl font-bold text-xs transition btn-press"
            :class="activeTab === item.key ? 'bg-emerald-700 text-white shadow-md shadow-emerald-900/40' : 'text-slate-400 hover:text-white hover:bg-slate-800/80'"
          >
            <div class="flex items-center gap-2.5">
              <span class="text-base">{{ item.icon }}</span>
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
              <span>{{ currentUser.role === 'owner' ? '店主 (主管理员)' : currentUser.role === 'clerk' ? '收银员/发型师' : '外部审计员' }}</span>
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
          <span class="text-xs text-slate-400">· 梦飞空间美容美发沙龙</span>
        </div>

        <!-- 右侧连接状态与快捷功能 -->
        <div class="flex items-center gap-3">
          <!-- 云端同步正常指示灯 -->
          <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border"
            :class="accountStatus === 'synced' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-800 border-amber-200'" role="status">
            <span>{{ syncLabel }}</span>
            <span class="text-[10px] text-emerald-500 font-mono">v{{ accountRevision }}</span>
          </div>
          <button v-if="hasPending" @click="retryPending" :disabled="isLoading || isSubmittingOperations"
            class="h-9 px-3 bg-amber-100 text-amber-900 rounded-xl text-xs font-bold disabled:opacity-50">继续确认待办</button>
          <button v-if="adminApi.pendingOperation.value" @click="resolvePending" :disabled="isLoading || isSubmittingOperations"
            class="h-9 px-3 text-rose-700 rounded-xl text-xs font-bold disabled:opacity-50">核对并取消未入账操作</button>
          <button v-if="pendingImport?.canCancel" @click="cancelRemainingImport" :disabled="isLoading"
            class="h-9 px-3 text-rose-700 rounded-xl text-xs font-bold">取消剩余导入</button>

          <!-- 刷新数据 -->
          <button
            @click="loadAccountData"
            :disabled="isLoading"
            class="h-9 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition flex items-center gap-1"
            title="手动刷新最新数据"
          >
            <span>🔄</span> 刷新
          </button>

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

      <!-- 动态路由工作台主体 -->
      <div v-if="accountError" class="px-6 py-3 bg-amber-50 text-amber-900 text-sm" role="alert">{{ accountError }}</div>
      <main :key="currentUser.storeId + ':' + currentUser.id" class="flex-1 overflow-y-auto p-6">
        <div v-if="!accountData" class="p-8 text-center text-slate-600">
          {{ isLoading ? '正在加载当前门店账本…' : '账本尚未加载，请点击刷新重试。' }}
        </div>
        <DashboardView
          v-else-if="activeTab === 'dashboard'"
          :members="members"
          :ledgers="ledgers"
          @switch-tab="tab => activeTab = tab"
        />

        <MembersView
          v-else-if="activeTab === 'members'"
          :members="members"
          @switch-tab="tab => activeTab = tab"
          :submit-operations="handleSyncOperations"
        />

        <LedgersView
          v-else-if="activeTab === 'ledgers'"
          :ledgers="ledgers"
          :members="members"
          :submit-operations="handleSyncOperations"
        />

        <ImportExportView
          v-else-if="activeTab === 'import-export'"
          :members="members"
          :ledgers="ledgers"
          @refresh-data="loadAccountData"
        />

        <ServicesView
          v-else-if="activeTab === 'services'"
          :services="services"
          :recharge-plans="rechargePlans"
          :recharge-settings="accountData.rechargeSettings"
          :submit-operations="handleSyncOperations"
        />

        <UsersView
          v-else-if="activeTab === 'users'"
        />

        <AuditLogView
          v-else-if="activeTab === 'audit'"
        />
      </main>
    </div>

    <!-- 安全锁屏覆盖层 (空闲 15 分钟或手动锁屏触发) -->
    <div v-if="isLocked" class="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-6 select-none">
      <div class="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl text-center border border-slate-200">
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
import { ref, computed, onMounted, watch } from 'vue';
import { adminApi } from './api/client.js';
import { useAutoLock } from './utils/security.js';
import LoginView from './views/LoginView.vue';
import DashboardView from './views/DashboardView.vue';
import MembersView from './views/MembersView.vue';
import LedgersView from './views/LedgersView.vue';
import ImportExportView from './views/ImportExportView.vue';
import ServicesView from './views/ServicesView.vue';
import UsersView from './views/UsersView.vue';
import AuditLogView from './views/AuditLogView.vue';

const currentUser = computed(() => adminApi.user.value);
const activeTab = ref('dashboard');
const accountData = adminApi.accountData;
const accountStatus = adminApi.accountStatus;
const accountError = adminApi.accountError;
const hasPending = adminApi.hasPending;
const pendingImport = adminApi.pendingImport;
const isLoading = computed(() => ['loading', 'saving'].includes(accountStatus.value) || adminApi.importing.value);
const members = computed(() => accountData.value?.members || []);
const ledgers = computed(() => accountData.value?.ledgers || []);
const services = computed(() => accountData.value?.services || []);
const rechargePlans = computed(() => accountData.value?.rechargePlans || []);
const accountRevision = adminApi.accountRevision;
const isSubmittingOperations = ref(false);
const syncLabel = computed(() => ({ idle: '账本尚未加载', loading: '正在加载账本', saving: '正在确认操作',
  synced: '云端账本已同步', pending: '有待确认操作', error: '账本确认失败，请重试' }[accountStatus.value]));

const isLocked = adminApi.isLocked;
const unlockPassword = ref('');
const unlockError = ref('');
const isUnlocking = ref(false);
watch(() => currentUser.value?.storeId + ':' + currentUser.value?.id, () => {
  activeTab.value = 'dashboard'; unlockPassword.value = ''; unlockError.value = '';
  if (currentUser.value && !isLocked.value) loadAccountData();
}, { flush: 'post' });

const navItems = [
  { key: 'dashboard', label: '经营大盘', icon: '📊' },
  { key: 'members', label: '会员档案', icon: '👥' },
  { key: 'ledgers', label: '财务流水', icon: '📑' },
  { key: 'import-export', label: '批量导入导出', icon: '📥', badge: '核心' },
  { key: 'services', label: '服务与卡项', icon: '💇' },
  { key: 'users', label: '员工权限', icon: '🛡️' },
  { key: 'audit', label: '安全审计', icon: '🔍' }
];

const currentNavLabel = computed(() => {
  return navItems.find(i => i.key === activeTab.value)?.label || '工作台';
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
    await loadAccountData();
  } catch (err) {
    unlockError.value = '密码错误，请重新输入';
  } finally {
    isUnlocking.value = false;
  }
}

async function loadAccountData() {
  if (!currentUser.value || isLocked.value) return;
  try {
    await adminApi.getAccount();
  } catch (err) {
    // The client exposes the error beside the current account; previous identities cannot populate it.
  }
}

async function handleSyncOperations(operations) {
  if (isSubmittingOperations.value) throw new Error('正在处理上一笔操作，请稍后重试');
  isSubmittingOperations.value = true;
  try {
    return await adminApi.sync(operations);
  } finally {
    isSubmittingOperations.value = false;
  }
}

async function retryPending() {
  if (isSubmittingOperations.value) return;
  isSubmittingOperations.value = true;
  try { await adminApi.retryPending(); }
  catch (error) { alert('待办确认失败：' + error.message); }
  finally { isSubmittingOperations.value = false; }
}

async function cancelRemainingImport() {
  if (!confirm('已经入库的记录将保留。取消尚未入库的部分后，请重新预检剩余数据。确定继续吗？')) return;
  try { await adminApi.cancelRemainingImport(); await loadAccountData(); }
  catch (error) { alert(error.message); }
}

async function resolvePending() {
  if (isSubmittingOperations.value || !confirm('服务器会核对原操作：已入账的保留，未入账的取消。完成后请按最新账本重新核对。确定继续吗？')) return;
  isSubmittingOperations.value = true;
  try {
    const result = await adminApi.resolvePending();
    activeTab.value = 'dashboard';
    alert(`已核对：${result.resolved.filter(row => row.status === 'committed').length} 笔已入账，${result.resolved.filter(row => row.status === 'cancelled').length} 笔已取消。${pendingImport.value ? '请取消剩余导入后重新预检。' : '可重新核对后记账。'}`);
  } catch (error) { alert('原操作核对尚未完成：' + error.message); }
  finally { isSubmittingOperations.value = false; }
}

async function handleLogout() {
  if (!confirm('确定要退出登录吗？')) return;
  try { await adminApi.logout(); }
  catch (error) { alert('本机已退出，云端会话撤销未完成：' + error.message); }
}

onMounted(() => {
  if (currentUser.value && !isLocked.value) {
    loadAccountData();
  }
});
</script>
