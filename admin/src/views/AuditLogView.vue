<template>
  <div class="space-y-4">
    <div class="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex flex-wrap items-center justify-between gap-4">
      <div>
        <h3 class="font-black text-slate-900 text-base">🔍 系统安全与操作审计日志</h3>
        <p class="text-xs text-slate-400 mt-0.5">全量不可篡改记录，包括员工登录、会员建档、扣款充值、批量导入与冲正</p>
      </div>
      <button
        @click="exportLogs"
        :disabled="isExporting"
        class="h-10 px-4 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black shadow transition flex items-center gap-1.5"
      >
        <span>📤</span> {{ isExporting ? `正在收集 ${exportCount} 条日志…` : '导出全部审计 Excel 归档' }}
      </button>
    </div>

    <div class="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div v-if="loading" class="text-center py-12 text-slate-400 text-sm">
        正在拉取安全审计流...
      </div>
      <div v-else-if="logs.length === 0" class="text-center py-12 text-slate-400 text-sm">
        暂无安全审计日志
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase">
              <th class="py-3 px-4 font-bold">编号</th>
              <th class="py-3 px-4 font-bold">操作时间</th>
              <th class="py-3 px-4 font-bold">操作人</th>
              <th class="py-3 px-4 font-bold">事件类型</th>
              <th class="py-3 px-4 font-bold">客户端设备</th>
              <th class="py-3 px-4 font-bold">操作详情与变更快照</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 font-medium">
            <tr v-for="l in logs" :key="l.id" class="hover:bg-slate-50/80 transition">
              <td class="py-3 px-4 font-mono text-xs text-slate-400">#{{ l.id }}</td>
              <td class="py-3 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                {{ formatDateTime(l.received_at) }}
              </td>
              <td class="py-3 px-4 font-black text-slate-900">
                {{ l.display_name || '系统自动' }}
              </td>
              <td class="py-3 px-4">
                <span class="px-2 py-0.5 rounded text-xs font-bold bg-slate-100 text-slate-700">
                  {{ l.event }}
                </span>
              </td>
              <td class="py-3 px-4 font-mono text-xs text-slate-400 truncate max-w-[140px]" :title="l.device_id">
                {{ l.device_id || '—' }}
              </td>
              <td class="py-3 px-4 text-xs font-mono text-slate-500 max-w-md truncate" :title="JSON.stringify(l.details)">
                {{ JSON.stringify(l.details) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <button v-if="hasMore" @click="loadLogs(true)" :disabled="loading" class="px-4 py-2 bg-white border rounded-xl text-sm">加载更早记录</button>
  </div>
</template>

<script setup>
import { storeFilePrefix } from '../../../src/store-profile.js';
import { ref, onMounted } from 'vue';
import { adminApi } from '../api/client.js';
import { exportAuditLogsToExcel } from '../utils/exporter.js';

const logs = ref([]);
const loading = ref(false);
const hasMore = ref(false);
const isExporting = ref(false);
const exportCount = ref(0);

async function loadLogs(append = false) {
  if (loading.value) return;
  loading.value = true;
  try {
    const page = await adminApi.getActivity({ before: append ? logs.value.at(-1)?.id : undefined });
    logs.value = append ? [...logs.value, ...page] : page;
    hasMore.value = page.length === 100;
  } catch (err) {
    alert('加载审计日志失败: ' + err.message);
  } finally {
    loading.value = false;
  }
}

async function exportLogs() {
  if (isExporting.value) return;
  isExporting.value = true; exportCount.value = 0;
  try {
    const all = await adminApi.getAllActivity(count => { exportCount.value = count; });
    exportAuditLogsToExcel(all, storeFilePrefix(adminApi.storeProfile.value) + '_安全审计日志');
  } catch (error) { alert('完整审计导出失败：' + error.message); }
  finally { isExporting.value = false; }
}

function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return isoStr;
  }
}

onMounted(() => {
  loadLogs();
});
</script>
