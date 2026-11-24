<template>
  <section class="book-stack" aria-label="资料批次">
    <div class="book-panel book-stack">
      <h3>资料批次</h3>
      <p>每批最多 500 行。支持 CSV 或 Excel。表头使用姓名、电话、备注、标签；编辑已有档案时须同时提供会员编号和原档案版本。批次不会写入资金。</p>
      <p v-if="captured" class="book-alert">捕获结果待核对：{{ captured.id }}。重选原表格可按原批次号继续。</p>
      <label v-if="writable">选择资料表格<input type="file" accept=".csv,.xlsx,.xls" :disabled="busy" @change="choose"></label>
      <div v-if="preview" class="book-stack">
        <p>预检通过：{{ preview.rows.length }} 行（新增 {{ newCount }}，编辑 {{ preview.rows.length - newCount }}）。</p>
        <div v-if="review?.positions.length" class="book-alert" role="alert">
          <p>有 {{ review.positions.length }} 行未留手机号，且与在用档案或表格中的其他行同名。请核对表格第 {{ review.positions.slice(0, 10).join('、') }}{{ review.positions.length > 10 ? ' 等' : '' }} 行。</p>
          <label class="book-inline"><input v-model="namesApproved" type="checkbox">这些同名记录已逐行核对，确认保留各自档案</label>
        </div>
        <button class="book-primary" type="button" :disabled="busy || workspace.state.busy || Boolean(workspace.state.pending) || !review || Boolean(review.positions.length && !namesApproved)" @click="capture">确认捕获为暂停批次</button>
      </div>
      <p v-if="message" role="status">{{ message }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
    </div>
    <div class="book-panel book-stack">
      <h3>当前账号与设备的批次</h3>
      <p v-if="!list.length">暂无批次。</p>
      <ul v-else class="book-list"><li v-for="row in list" :key="row.batchId"><button type="button" class="book-link" @click="open(row.batchId)">{{ row.batchId }}</button><span>{{ row.itemCount }} 行</span></li></ul>
      <div class="book-actions">
        <button type="button" :disabled="busy" @click="load()">刷新批次</button>
        <button v-if="next" type="button" :disabled="busy" @click="load(next)">下一页</button>
      </div>
    </div>
    <div v-if="current" class="book-panel book-stack">
      <h3 class="book-break">批次 {{ current.batchId }}</h3>
      <p>已确认 {{ current.completedCount }} / {{ current.itemCount }} · 待执行 {{ current.pendingCount }} · 已取消 {{ current.cancelledCount }}</p>
      <div class="book-actions">
        <button v-if="writable && current.pendingCount && !working" type="button" class="book-primary" :disabled="busy || Boolean(workspace.state.pending)" @click="resume">继续原批次</button>
        <button v-if="writable && current.state === 'active' && current.pendingCount" type="button" :disabled="busy" @click="control('paused')">暂停</button>
        <button v-if="writable && current.pendingCount" type="button" :disabled="busy" @click="cancel">取消剩余行</button>
        <button v-if="current.nextAfter !== null && !working" type="button" :disabled="busy" @click="open(current.batchId, current.nextAfter)">下一页进度</button>
      </div>
      <ul class="book-list"><li v-for="row in current.items" :key="row.taskId"><span>第 {{ row.position + 1 }} 行 · {{ row.type === 'member.create' ? '新增' : row.type === 'member.update' ? '编辑' : '归档' }}</span><span>{{ states[row.state] }}</span></li></ul>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { batchIntake, readProfileBatch, reviewBatchNames } from '../relational-profile-batches.js';
import { createBatchRunner } from '../relational-batch-runner.js';
const props = defineProps({ workspace: Object, writable: Boolean });
const intake = batchIntake(props.workspace), batch = props.workspace.batch;
const runner = createBatchRunner({ repository: batch, getScope: props.workspace.getScope });
const busy = ref(false), working = shallowRef(null), preview = shallowRef(null), captured = shallowRef(null), list = shallowRef([]), next = shallowRef(null);
const current = shallowRef(null), error = ref(''), message = ref('');
const review = shallowRef(null), namesApproved = ref(false);
const states = { completed: '已确认', pending: '待执行', cancelled: '已取消' };
const newCount = computed(() => preview.value?.rows.filter(row => row.type === 'member.create').length ?? 0);
let active = true, selection, selectedScope;
onScopeDispose(() => { active = false; selection?.abort(); working.value?.abort(); });
function pending() { try { captured.value = intake.pending(); } catch (cause) { error.value = cause.message; } }
async function action(work) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { await work(); } catch (cause) { if (active && cause.name !== 'AbortError') error.value = cause.message; }
  finally { busy.value = false; if (active) pending(); }
}
async function loadList(after) {
  const page = await batch.listBatches({ ...(after ? { after } : {}), limit: 25 });
  if (active) { list.value = page.items; next.value = page.nextAfter; }
}
function load(after) { void action(() => loadList(after)); }
async function loadBatch(scope, after) {
  const value = await batch.getBatch(scope, { ...(after === undefined ? {} : { after }), limit: 25 });
  if (active) current.value = value;
}
function open(id, after) {
  if (working.value) return;
  void action(() => loadBatch({ ...props.workspace.getScope(), id }, after));
}
function choose(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  selection?.abort(); preview.value = null; review.value = null; namesApproved.value = false;
  if (!file) return;
  const verify = new AbortController(); selection = verify; const scope = props.workspace.getScope();
  void action(async () => {
    const result = await readProfileBatch(file, { signal: verify.signal });
    const names = captured.value ? { positions: [], signature: '' } : await reviewBatchNames(result, props.workspace.read);
    if (active && selection === verify) { preview.value = result; review.value = names; selectedScope = scope; }
  });
}
function capture() {
  const file = preview.value;
  if (!file || !review.value || review.value.positions.length && !namesApproved.value || !globalThis.confirm('捕获这批资料？系统会先保存批次，逐行写入需要另外点击继续。')) return;
  void action(async () => {
    if (!captured.value) {
      const latest = await reviewBatchNames(file, props.workspace.read);
      if (!active) return;
      if (latest.signature !== review.value.signature) {
        review.value = latest; namesApproved.value = false;
        throw new Error('同名档案已变化，请按新结果重新核对。');
      }
    }
    const value = await intake.capture(file, selectedScope); if (!active) return;
    preview.value = null; await loadList(); await loadBatch({ ...selectedScope, id: value.batchId });
    message.value = '已捕获原批次，等待明确继续。';
  });
}
const scopeFor = value => ({ ...props.workspace.getScope(), id: value.batchId });
function control(state) {
  const initial = current.value;
  working.value?.abort();
  void action(async () => {
    const scope = scopeFor(initial); await batch.controlBatch({ ...scope, expectedVersion: initial.version, state });
    await loadBatch(scope);
  });
}
function cancel() { if (globalThis.confirm('已确认行会保留。取消后，剩余行不可继续。确定取消？')) control('cancelled'); }
async function resume() {
  const row = current.value, scope = scopeFor(row); if (!active || working.value || busy.value) return;
  error.value = ''; message.value = '';
  const run = new AbortController(); working.value = run;
  try {
    if (row.state !== 'active') await batch.controlBatch({ ...scope, expectedVersion: row.version, state: 'active' });
    await runner.run(scope, { signal: run.signal, onProgress: value => { if (active && !run.signal.aborted) current.value = value; } });
    if (active && !run.signal.aborted) await loadBatch(scope);
  } catch (cause) { if (active && !run.signal.aborted) error.value = '批次保留原进度：' + cause.message; }
  finally { working.value = null; if (active && !run.signal.aborted) { try { await loadBatch(scope); } catch {} } }
}
onMounted(() => { pending(); load(); });
</script>
