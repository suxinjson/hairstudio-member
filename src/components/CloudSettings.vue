<template>
  <section class="bg-white rounded-3xl p-5 border border-slate-200 space-y-4">
    <div>
      <h2 class="font-black text-lg">☁️ 云端账号与同步</h2>
      <p class="text-sm text-slate-600 mt-1">首次登录需要联网。已登录设备断网时继续记账，联网后自动同步。</p>
    </div>
    <p v-if="message || state.error" class="rounded-xl bg-amber-50 text-amber-900 p-3" role="status">{{ message || state.error }}</p>
    <form v-if="!state.user" @submit.prevent="login" class="space-y-3">
      <label class="block">服务器地址
        <input v-model.trim="form.serverUrl" type="url" required placeholder="https://member.example.com" class="w-full border rounded-xl p-3 mt-1" :disabled="state.busy" />
      </label>
      <label class="block">账号
        <input v-model.trim="form.username" autocomplete="username" required class="w-full border rounded-xl p-3 mt-1" :disabled="state.busy" />
      </label>
      <label class="block">密码
        <input v-model="form.password" type="password" autocomplete="current-password" required class="w-full border rounded-xl p-3 mt-1" :disabled="state.busy" />
      </label>
      <button type="submit" :disabled="state.busy" class="w-full rounded-xl p-3 bg-indigo-700 text-white font-bold disabled:opacity-50">{{ state.busy ? '正在连接…' : '安全登录' }}</button>
    </form>
    <template v-else>
      <div class="rounded-xl bg-slate-50 p-3">
        <p class="font-bold">{{ state.user.displayName }} · {{ roles[state.user.role] }}</p>
        <p class="text-sm mt-1">{{ state.online ? '设备已联网' : '设备离线' }} · {{ statuses[state.status] || state.status }}</p>
        <p v-if="state.binding" class="text-sm mt-1">待同步 {{ state.outbox.length }} 笔<span v-if="state.lastSync"> · 上次成功 {{ new Date(state.lastSync).toLocaleString() }}</span></p>
      </div>
      <div v-if="state.status === 'needs-bootstrap'" class="rounded-xl p-3 bg-blue-50 space-y-2">
        <p>云端尚无账本，可以将本机会员和流水迁移为初始云端账本。</p>
        <button @click="bootstrap" :disabled="state.busy" class="rounded-xl p-3 bg-indigo-700 text-white font-bold">上传本机初始账本</button>
      </div>
      <div v-if="state.status === 'needs-choice' || state.status === 'conflict' || recoveryRequired" class="rounded-xl p-3 bg-amber-50 space-y-3">
        <p>{{ resolutionMessage }}</p>
        <button @click="exportPending" :disabled="state.busy" class="rounded-xl p-3 bg-white border font-bold">导出本机账本与待同步记录</button>
        <button @click="useCloud" :disabled="state.busy || !state.online" class="rounded-xl p-3 border border-rose-300 text-rose-800 font-bold">采用云端账本，放弃本机待同步变更</button>
        <button v-if="state.status === 'conflict' && state.conflictReason === 'recovery' && state.user.role === 'owner'" @click="uploadRecovered" :disabled="state.busy || !state.online || recoveryRequired" class="rounded-xl p-3 border border-indigo-300 text-indigo-800 font-bold">确认上传恢复后的本机账本</button>
      </div>
      <div class="flex flex-wrap gap-2">
        <button @click="perform(() => cloudClient.sync())" :disabled="state.busy || !state.binding || state.status === 'conflict'" class="rounded-xl p-3 bg-emerald-700 text-white font-bold disabled:opacity-50">立即同步</button>
        <button @click="perform(() => cloudClient.logout())" :disabled="state.busy" class="rounded-xl p-3 border font-bold">退出登录</button>
        <button @click="unlink" :disabled="state.busy || state.outbox.length || Boolean(state.bootstrap)" class="rounded-xl p-3 border font-bold">解除云端绑定</button>
      </div>
      <p v-if="state.user.role === 'viewer'" class="text-sm text-slate-600">此账号可查看账本，不能进行充值、扣款或修改资料。</p>
      <div v-if="state.user.role === 'owner'" class="pt-4 border-t space-y-3">
        <h3 class="font-black">账号与使用记录</h3>
        <div class="flex gap-2">
          <button @click="loadUsers" class="border rounded-xl p-3">管理账号</button>
          <button @click="loadAudit" class="border rounded-xl p-3">查看最近使用记录</button>
        </div>
        <div v-if="users" class="space-y-3">
          <div v-for="user in users" :key="user.id" class="p-3 border rounded-xl space-y-2">
            <p class="font-bold">{{ user.displayName }}（{{ user.username }}）· {{ user.active ? '在用' : '停用' }}</p>
            <select v-model="user.role" class="p-2 border rounded-lg" aria-label="账号权限"><option value="owner">店主</option><option value="clerk">店员</option><option value="viewer">只读</option></select>
            <button @click="updateUser(user, user.active)" class="p-2 border rounded-lg ml-2">保存权限</button>
            <button @click="updateUser(user, !user.active)" class="p-2 border rounded-lg ml-2">{{ user.active ? '停用' : '启用' }}</button>
          </div>
          <form @submit.prevent="createUser" class="space-y-2 border rounded-xl p-3">
            <h4 class="font-bold">新增账号</h4>
            <input v-model.trim="newUser.displayName" required placeholder="姓名" class="w-full border rounded-xl p-3" aria-label="新账号姓名" />
            <input v-model.trim="newUser.username" required placeholder="账号（至少 3 位英文或数字）" class="w-full border rounded-xl p-3" aria-label="新账号" />
            <input v-model="newUser.password" type="password" required minlength="12" autocomplete="new-password" placeholder="密码（至少 12 位）" class="w-full border rounded-xl p-3" aria-label="新账号密码" />
            <select v-model="newUser.role" class="border rounded-lg p-2" aria-label="新账号权限"><option value="clerk">店员</option><option value="viewer">只读</option><option value="owner">店主</option></select>
            <button type="submit" class="rounded-xl p-3 bg-indigo-700 text-white font-bold ml-2">创建账号</button>
          </form>
        </div>
        <div v-if="audit" class="max-h-80 overflow-y-auto space-y-2">
          <p v-for="event in audit" :key="event.id" class="text-sm border rounded-xl p-3">{{ event.display_name || '系统' }} · {{ eventNames[event.event] || event.event }} · {{ new Date(event.received_at).toLocaleString() }}</p>
        </div>
      </div>
      <div class="pt-4 border-t space-y-3">
        <h3 class="font-black">应用更新</h3>
        <button @click="checkUpdate" :disabled="state.busy || downloading" class="border rounded-xl p-3">检查更新</button>
        <div v-if="update" class="space-y-2 rounded-xl bg-slate-50 p-3">
          <p class="font-bold">新版本 {{ update.versionName }}</p><p class="text-sm whitespace-pre-wrap">{{ update.notes }}</p>
          <p v-if="downloading" role="status">下载中 {{ progress }}%</p>
          <button v-if="!downloaded" @click="download" :disabled="downloading" class="rounded-xl bg-indigo-700 text-white p-3 font-bold">下载并校验更新</button>
          <button v-else-if="!downloaded.browser" @click="install" class="rounded-xl bg-emerald-700 text-white p-3 font-bold">打开系统安装界面</button>
          <p v-else>已发起 APK 下载，请在浏览器下载记录中确认，再打开安装。</p>
        </div>
      </div>
    </template>
  </section>
</template>
<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { cloudClient, checkForUpdate, downloadUpdate, installUpdate } from '../cloud-device.js';
import { localDb } from '../storage.js';
import { exportFile } from '../file-export.js';
const props = defineProps({ recoveryRequired: { type: Boolean, default: false } });
const roles = { owner: '店主', clerk: '店员', viewer: '只读' };
const statuses = { local: '仅本机账本', pending: '等待同步', synced: '同步完成', conflict: '需要核对', 'login-required': '需要登录', 'needs-bootstrap': '等待初始迁移', 'needs-choice': '等待选择账本' };
const eventNames = { login: '登录', online: '联网', offline: '断网', bootstrap: '初始迁移', createMember: '新增会员', updateMember: '修改会员', deleteMember: '注销会员', recharge: '充值', consume: '消费', refundLedger: '撤销', saveService: '修改服务', deleteService: '删除服务', importBackupData: '恢复备份', user_created: '创建账号', user_permissions_changed: '修改权限', sync_conflict_resolved: '处理同步冲突' };
const state = ref(cloudClient.snapshot());
const unsubscribe = cloudClient.subscribe(value => { state.value = value; });
onUnmounted(unsubscribe);
const form = ref({ serverUrl: state.value.serverUrl || '', username: '', password: '' });
const newUser = ref({ username: '', displayName: '', password: '', role: 'clerk' });
const message = ref(''), users = ref(null), audit = ref(null), update = ref(null), downloaded = ref(null), downloading = ref(false), progress = ref(0);
const resolutionMessage = computed(() => {
  if (props.recoveryRequired) return '本机账本无法读取。可先导出原始数据与待办，联网后采用云端账本；店主也可通过备份中心恢复本机账本。';
  if (state.value.conflictReason === 'recovery') return '已恢复本机账本，原始数据和待办已保存。请先导出核对；联网后可采用云端账本，或由店主确认用恢复结果覆盖云端。';
  if (state.value.conflictReason === 'permissions') return '账号权限已变化，部分待办不能上传。记录仍在本机，请先导出并交由店主核对，再决定是否采用云端账本。';
  if (state.value.conflictReason === 'bootstrap') return '其他设备已初始化云端，本机初始账本和待办已保留。请先导出并核对，再决定是否采用云端账本。';
  return state.value.status === 'conflict' ? '两台设备修改了同一会员或设置，本机记录已保留。请先导出本机账本并核对，再决定如何处理。' : '本机与云端均有账本。请先备份本机，再选择是否采用云端账本。';
});
async function perform(action) { message.value = ''; try { await action(); } catch (error) { message.value = error.message; } }
async function login() { await perform(async () => { await cloudClient.login(form.value.serverUrl, form.value.username, form.value.password); form.value.password = ''; await cloudClient.sync(); }); }
async function bootstrap() { if (confirm('将本机会员和流水迁移为云端的初始账本？此操作只允许店主在云端为空时执行。')) await perform(async () => { await cloudClient.bootstrap(); await cloudClient.sync(); }); }
async function exportPending() {
  await perform(async () => {
    const content = { version: '2.0', exportedAt: new Date().toISOString(), appName: '梦飞空间会员管家', ...localDb.readRecoveryState() };
    content.cloud = { serverUrl: state.value.serverUrl, binding: state.value.binding, outbox: state.value.outbox, bootstrap: state.value.bootstrap };
    await exportFile({ content: JSON.stringify(content, null, 2), fileName: '本机账本与待同步记录_' + new Date().toISOString().slice(0, 10) + '.json', mimeType: 'application/json', title: '本机待同步账本备份' });
    message.value = '已发起备份导出，请确认接收端文件可打开，再采用云端账本。';
  });
}
async function useCloud() { if (confirm('请先导出并核对本机账本。确认放弃本机尚未同步的变更，改用云端账本？覆盖前会保存一份本机恢复点。')) await perform(() => cloudClient.useCloudLedger()); }
async function uploadRecovered() { if (confirm('确认用恢复后的本机完整账本覆盖云端？请先导出并核对原待办和云端流水，避免遗漏其他设备交易。原待办将归档，再上传本次完整恢复。')) await perform(() => cloudClient.uploadRecoveredLedger()); }
async function unlink() { if (confirm('确认解除云端绑定并继续使用本机账本？请先保留外部备份。')) await perform(() => cloudClient.unlink()); }
async function loadUsers() { await perform(async () => { users.value = await cloudClient.request('/users'); }); }
async function loadAudit() { await perform(async () => { audit.value = await cloudClient.request('/activity'); }); }
async function createUser() { await perform(async () => { await cloudClient.request('/users', newUser.value); newUser.value.password = ''; await loadUsers(); message.value = '账号已创建'; }); }
async function updateUser(user, active) { if (confirm('确认更新此账号权限？该账号已有登录会立即失效，需要重新登录。')) await perform(async () => { await cloudClient.request('/users/' + user.id, { role: user.role, active }, 'PATCH'); await loadUsers(); }); }
async function checkUpdate() { await perform(async () => { update.value = await checkForUpdate(); downloaded.value = null; if (!update.value) message.value = '当前没有可用的新版本'; }); }
async function download() {
  downloading.value = true; progress.value = 0;
  await perform(async () => { await cloudClient.sync(); if (state.value.outbox.length || state.value.status === 'conflict') throw new Error('请先同步或处理待办记录，再下载更新'); downloaded.value = await downloadUpdate(update.value, value => { progress.value = value; }); });
  downloading.value = false;
}
async function install() { await perform(async () => { const result = await installUpdate(downloaded.value, update.value); message.value = result.status === 'permission-required' ? '请允许此应用安装更新，返回后再次点击安装。' : '已打开安卓系统安装界面，请按系统提示完成更新。'; }); }
</script>
