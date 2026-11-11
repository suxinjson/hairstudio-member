<template>
  <section class="bg-white rounded-3xl p-6 space-y-5">
    <div class="flex justify-between items-center">
      <div><h3 class="text-lg font-black">设备授权管理</h3><p class="text-sm text-slate-500 mt-2">同一账号支持多设备、多页面登录。首次未登录可试用 7 天，已登录设备默认允许离线 7 天。</p></div>
      <button @click="load" :disabled="loading || saving" class="border rounded-xl px-4 py-2">刷新设备</button>
    </div>
    <p class="text-sm text-amber-900 bg-amber-50 p-3 rounded-xl">断网设备会在下次联网或离线期限到期后执行限制。需要持续联网核验的设备，请设为“禁止离线”。</p>
    <p v-if="error" role="alert" class="text-rose-700">{{ error }}</p>
    <p v-if="message" role="status" class="text-emerald-700">{{ message }}</p>
    <p v-if="loading">正在加载设备…</p>
    <p v-else-if="!devices.length">设备登录后会显示在这里。</p>
    <div v-for="device in devices" :key="device.deviceId" class="border rounded-2xl p-5 space-y-4">
      <div class="flex justify-between gap-4"><div><p class="font-bold">{{ device.label || device.deviceName || (device.kind === 'native' ? '安卓手机' : '网页') }} · {{ device.displayName || '账号' }}</p>
        <p class="text-sm text-slate-500">最近联网：{{ new Date(device.lastSeenAt).toLocaleString('zh-CN') }}</p></div>
        <span class="font-bold" :class="device.active ? 'text-emerald-700' : 'text-rose-700'">{{ device.active ? '已启用' : '已禁用' }}</span></div>
      <div class="grid md:grid-cols-3 gap-4">
        <label>设备备注<input v-model.trim="device.label" maxlength="128" class="block w-full border rounded-xl p-3 mt-1" /></label>
        <label>离线使用<select v-model="device.offlineMode" class="block w-full border rounded-xl p-3 mt-1"><option value="allow">允许离线</option><option value="deny">禁止离线，必须联网登录</option></select></label>
        <label v-if="device.offlineMode === 'allow'">每次联网后离线可用小时数<input v-model.number="device.offlineHours" type="number" min="1" max="8760" step="1" class="block w-full border rounded-xl p-3 mt-1" /></label>
        <label>授权到期时间<input v-model="device.expiry" type="datetime-local" class="block w-full border rounded-xl p-3 mt-1" /><span class="text-xs text-slate-500">留空为长期授权</span></label>
      </div>
      <div class="flex gap-3"><button @click="save(device, device.active)" :disabled="saving" class="bg-emerald-700 text-white rounded-xl p-3 font-bold">保存授权</button>
        <button @click="save(device, !device.active)" :disabled="saving" class="border rounded-xl p-3 font-bold">{{ device.active ? '禁用设备' : '启用设备' }}</button></div>
    </div>
  </section>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { adminApi } from '../api/client.js';
const devices = ref([]), loading = ref(false), saving = ref(false), error = ref(''), message = ref('');
function localDate(value) { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
async function load() {
  loading.value = true; error.value = '';
  try { devices.value = (await adminApi.getDevices()).map(d => ({ ...d, offlineMode: d.offlineHours ? 'allow' : 'deny', expiry: localDate(d.authorizedUntil) })); }
  catch (e) { error.value = e.message; } finally { loading.value = false; }
}
async function save(device, active) {
  if (!active && !window.confirm(`禁用「${device.label || device.deviceName || '这台设备'}」后，该设备联网将无法使用 App。确定禁用？`)) return;
  if (saving.value) return;
  saving.value = true; error.value = ''; message.value = '';
  try {
    const offlineHours = device.offlineMode === 'deny' ? 0 : device.offlineHours;
    if (!Number.isInteger(offlineHours) || offlineHours < 0 || offlineHours > 8760 || device.offlineMode === 'allow' && offlineHours === 0) throw new Error('离线时长请填写 1–8760 小时');
    const authorizedUntil = device.expiry ? new Date(device.expiry).toISOString() : null;
    await adminApi.updateDevice(device.deviceId, { active, offlineHours, authorizedUntil, label: device.label });
    message.value = '设备授权已保存'; await load();
  } catch (e) { error.value = e.message; } finally { saving.value = false; }
}
onMounted(load);
</script>
