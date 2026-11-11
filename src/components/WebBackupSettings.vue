<template>
  <section class="bg-white rounded-3xl p-5 border border-slate-200 space-y-4">
    <h2 class="font-black text-lg">服务器账本导出</h2>
    <p class="text-sm text-slate-600">导出前会重新读取服务器的最新账本。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <button @click="download(false)" :disabled="busy" class="rounded-xl p-3 bg-emerald-700 text-white font-bold">导出完整账本</button>
    <button @click="download(true)" :disabled="busy" class="rounded-xl p-3 border font-bold ml-2">导出 Excel 对账明细表 (.csv)</button>
    <a href="/admin/" class="block text-indigo-700">在管理后台导入会员与管理备份</a>
  </section>
</template>

<script setup>
import { ref } from 'vue';
import { cloudClient } from '../cloud-device.js';
import { exportFile } from '../file-export.js';
import { storeFilePrefix } from '../store-profile.js';
const busy = ref(false), message = ref('');
async function download(csv) {
  if (busy.value) return;
  busy.value = true; message.value = '';
  try {
    await cloudClient.sync();
    const state = cloudClient.snapshot();
    if (!state.user || state.status !== 'synced') throw new Error('请先登录并确认服务器账本');
    const db = cloudClient.getDb();
    const result = await exportFile({ content: csv ? db.exportCSV() : db.exportBackupData(),
      fileName: storeFilePrefix(cloudClient.getStoreProfile()) + '_服务器账本_' + new Date().toISOString().slice(0, 10) + (csv ? '.csv' : '.json'),
      mimeType: csv ? 'text/csv' : 'application/json', title: '服务器账本导出' });
    message.value = result.kind === 'shared' ? '已完成分享，请确认文件可以打开。' : '已发起下载，请在下载记录中确认文件。';
  } catch (error) { message.value = error.message; }
  finally { busy.value = false; }
}
</script>
