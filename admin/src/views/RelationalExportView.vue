<template>
  <section class="book-panel book-stack" aria-label="表格导出">
    <h3>表格导出</h3>
    <p>表格用于日常核对；完整恢复请使用业务备份。</p>
    <div v-if="feature('members')" class="book-actions">
      <button type="button" :disabled="busy" @click="downloadMembers">导出会员档案 XLSX（最多 {{ EXPORT_ROWS.toLocaleString() }} 行）</button>
      <template v-if="busy"><p role="status">已读取 {{ count }} 行，正在核对…</p><button type="button" @click="controller?.abort()">取消导出</button></template>
    </div>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
    <template v-if="feature('cashier')">
      <h4>财务流水 XLSX</h4>
      <p>最多 {{ LEDGER_EXPORT.days }} 天、{{ LEDGER_EXPORT.rows.toLocaleString() }} 行和 8 MiB。可离开页面，文件自提交起保留 {{ LEDGER_EXPORT.minutes }} 分钟。</p>
      <form class="book-actions" @submit.prevent="queue">
        <label>开始日期<input v-model="first" type="date" :disabled="jobBusy || !!job || !!pending" required></label>
        <label>结束日期<input v-model="last" type="date" :disabled="jobBusy || !!job || !!pending" required></label>
        <button :disabled="jobBusy || !!job">{{ pending ? '用原任务号重试提交' : '提交流水导出' }}</button>
      </form>
      <div v-if="job" class="book-actions">
        <p role="status">{{ jobStatus }} · {{ localTime(job.expiresAt) }} 到期</p>
        <button v-if="job.state === 'ready'" type="button" :disabled="jobBusy" @click="downloadLedger">下载流水 XLSX</button>
        <button type="button" :disabled="jobBusy" @click="discard">{{ inProgress ? '取消任务' : '清除任务' }}</button>
      </div>
      <button v-if="jobError || inProgress" type="button" :disabled="jobBusy" @click="refresh">刷新任务状态</button>
      <p v-if="jobError" role="alert">{{ jobError }}</p>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { businessDays, todayBusiness } from '../../../src/relational-presentation.js';
import { LEDGER_EXPORT } from '../../../src/relational-export-sheet.js';
import { collectMemberExport, EXPORT_ROWS, relationalExportBook } from '../utils/relational-export.js';

const props = defineProps({ workspace: Object, feature: Function, jobs: Object });
const first = ref(todayBusiness()), last = ref(first.value), busy = ref(false), count = ref(0), message = ref(''), failed = ref(false);
const controller = shallowRef(null);
function cancel() { controller.value?.abort(); }
onBeforeUnmount(cancel);
async function downloadMembers() {
  if (busy.value) return;
  busy.value = true; count.value = 0; message.value = ''; failed.value = false; controller.value = new AbortController();
  const signal = controller.value.signal;
  try {
    const XLSX = await import('xlsx'), data = await collectMemberExport(props.workspace, { signal,
      progress: value => { count.value = value; } });
    if (signal.aborted) return;
    XLSX.writeFile(relationalExportBook(XLSX, data), data.name + '_' + todayBusiness() + '.xlsx');
    message.value = '已生成 ' + (data.rows.length - 1) + ' 行表格。';
  } catch (error) { failed.value = !signal.aborted; message.value = signal.aborted ? '已取消导出。' : error.message; }
  finally { controller.value = null; busy.value = false; }
}

const job = ref(null), pending = ref(null), jobError = ref(''), jobBusy = ref(false);
const inProgress = computed(() => ['queued', 'running'].includes(job.value?.state));
const localTime = instant => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' }).format(new Date(instant));
const jobStatus = computed(() => ({ queued: '排队中', running: '正在生成', ready: '已生成 ' + job.value.rows + ' 行，账本快照：' + (job.value.snapshotAt ? localTime(job.value.snapshotAt) : ''),
  failed: ({ EXPORT_ROW_LIMIT: '超过行数上限，请缩小日期范围。', EXPORT_BYTES_LIMIT: '超过文件体积上限，请缩小日期范围。',
    EXPORT_TIMEOUT: '生成超时，请缩小日期范围后重试。', EXPORT_CONTEXT_CHANGED: '原登录或账本已变化，请重新提交。' })[job.value.failure] || '生成失败，请重试。' })[job.value.state]);
let life, timer;
const scopeKey = () => JSON.stringify(props.workspace.getScope());
watch([scopeKey, () => props.feature('cashier')], ([key, enabled]) => {
  life?.abort(); clearTimeout(timer); job.value = null; pending.value = null; jobError.value = ''; jobBusy.value = false;
  if (key !== 'null' && enabled) { life = new AbortController(); void refresh(); }
}, { immediate: true });
onBeforeUnmount(() => { life?.abort(); clearTimeout(timer); });

async function runJob(action) {
  if (!life || life.signal.aborted || jobBusy.value) return;
  clearTimeout(timer); jobBusy.value = true; jobError.value = '';
  const scope = props.workspace.getScope(), signal = life.signal;
  try { await action(scope, signal); }
  catch (error) { if (!signal.aborted) jobError.value = error.message; }
  finally {
    if (!signal.aborted) {
      jobBusy.value = false;
      if (inProgress.value && !jobError.value) timer = setTimeout(refresh, 3000);
      else if (job.value && !jobError.value) timer = setTimeout(refresh, Math.max(500, Date.parse(job.value.expiresAt) - Date.now() + 1000));
    }
  }
}
function refresh() {
  return runJob(async (scope, signal) => {
    const latest = await props.jobs.current(scope, signal);
    if (latest) pending.value = null; job.value = latest;
  });
}
function queue() {
  return runJob(async (scope, signal) => {
    if (!pending.value) {
      const period = businessDays(first.value, last.value);
      if (Date.parse(period.to) - Date.parse(period.from) > LEDGER_EXPORT.days * 86400000) throw new Error('一次最多选择 366 天');
      pending.value = { id: crypto.randomUUID(), ...period };
    }
    try {
      job.value = await props.jobs.queue(scope, pending.value, signal); pending.value = null;
    } catch (error) {
      if (error.status && error.status < 500) pending.value = null;
      throw error;
    }
  });
}
function discard() {
  return runJob(async (scope, signal) => { await props.jobs.discard(scope, job.value.id, signal); job.value = null; });
}
function downloadLedger() {
  return runJob(async (scope, signal) => {
    const { id, snapshotAt } = job.value, file = await props.jobs.download(scope, id, signal);
    const url = URL.createObjectURL(file), link = document.createElement('a');
    try {
      link.href = url; link.download = '财务流水_' + snapshotAt.slice(0, 10) + '.xlsx'; document.body.append(link); link.click();
    } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  });
}
</script>
