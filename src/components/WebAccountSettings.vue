<template>
  <section class="bg-white rounded-3xl p-5 border border-slate-200 space-y-4">
    <h2 class="font-black text-lg">账号与连接</h2>
    <p class="text-sm text-slate-600">收银网页直接使用服务器账本，可与手机和管理后台同时登录。</p>
    <p v-if="state.locked" class="rounded-xl bg-amber-50 p-3">15 分钟无操作后已锁屏，请输入密码重新进入。服务器会话与手机登录仍各自保留。</p>
    <p v-if="message || state.error" class="rounded-xl bg-amber-50 p-3" role="status">{{ message || state.error }}</p>
    <form v-if="!state.user" @submit.prevent="login" class="space-y-3">
      <label class="block">账号<input v-model.trim="username" autocomplete="username" required class="w-full border rounded-xl p-3 mt-1" :disabled="state.busy" /></label>
      <label class="block">密码<input v-model="password" type="password" autocomplete="current-password" required class="w-full border rounded-xl p-3 mt-1" :disabled="state.busy" /></label>
      <button type="submit" :disabled="state.busy" class="w-full rounded-xl p-3 bg-indigo-700 text-white font-bold">{{ state.busy ? '正在连接…' : '安全登录' }}</button>
    </form>
    <template v-else>
      <p class="font-bold">{{ state.user.displayName }} · {{ roles[state.user.role] }}</p>
      <p class="text-sm">{{ state.status === 'synced' ? '服务器账本已加载' : state.busy ? '正在请求服务器' : '请重新加载服务器账本' }}</p>
      <div v-if="state.pending" class="rounded-xl bg-amber-50 p-3 space-y-2">
        <p>上一笔操作的结果尚未确认，请先核对原操作，避免重复记账。</p>
        <button @click="perform(() => cloudClient.retryPending())" :disabled="state.busy" class="border rounded-xl p-3 font-bold">继续确认原操作</button>
        <button @click="resolve" :disabled="state.busy" class="border rounded-xl p-3">核对并取消未入账的原操作</button>
      </div>
      <div class="flex flex-wrap gap-2">
        <button @click="perform(() => cloudClient.sync())" :disabled="state.busy" class="rounded-xl p-3 bg-emerald-700 text-white font-bold">重新加载账本</button>
        <button @click="perform(() => cloudClient.logout())" :disabled="state.busy" class="rounded-xl p-3 border font-bold">退出网页登录</button>
      </div>
      <p v-if="state.user.role === 'viewer'" class="text-sm text-slate-600">此账号仅可查看账本。</p>
      <a href="/admin/" class="block text-indigo-700 font-bold">打开管理后台</a>
    </template>
  </section>
</template>

<script setup>
import { ref, onUnmounted } from 'vue';
import { cloudClient } from '../cloud-device.js';
const props = defineProps({ askConfirm: { type: Function, required: true } });
const emit = defineEmits(['logged-in']);
const state = ref(cloudClient.snapshot());
const unsubscribe = cloudClient.subscribe(value => { state.value = value; });
onUnmounted(unsubscribe);
const username = ref(''), password = ref(''), message = ref('');
const roles = { owner: '店主', clerk: '店员', viewer: '只读' };
async function perform(action) { message.value = ''; try { await action(); } catch (error) { message.value = error.message; } }
async function login() {
  await perform(async () => {
    await cloudClient.login(state.value.serverUrl, username.value, password.value);
    password.value = ''; emit('logged-in');
  });
}
async function resolve() {
  if (await props.askConfirm({ title: '核对原操作', message: '已入账的操作会保留，尚未入账的原操作会取消。请先核对流水，确认继续？', confirmText: '确认核对', cancelText: '取消', danger: true })) {
    await perform(() => cloudClient.resolvePending());
  }
}
</script>
