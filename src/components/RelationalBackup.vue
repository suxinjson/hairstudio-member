<template>
  <section class="book-panel book-stack" aria-label="账本备份和恢复">
    <h3>账本备份和恢复</h3>
    <p>导出到应用外后会读回核验。恢复仅用于同门店的新空账本；已有新交易时不会覆盖。</p>
    <div class="book-actions">
      <button v-if="controller.canSave" type="button" class="book-primary" :disabled="Boolean(job)" @click="save">导出并核验外部文件</button>
      <p v-else class="book-muted">请用支持文件保存选择器的 Chrome 或 Edge 导出。</p>
      <button v-if="controller.native && !pending" type="button" :disabled="Boolean(job)" @click="choose()">选择文件并预览</button>
      <label v-else-if="!controller.native">{{ pending ? '重选原文件续办（已有回执时可直接查询）' : '选择账本备份文件' }}
        <input type="file" accept=".ndjson,application/x-ndjson" :disabled="Boolean(job)" @change="selected">
      </label>
      <button v-if="job" type="button" @click="job.abort()">停止等待</button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="review && !pending" class="book-alert book-stack">
      <p>已核验 {{ review.memberCount }} 位会员、{{ review.entryCount }} 笔流水。请核对同店备份与目标。</p>
      <p class="book-break">摘要 {{ review.sourceDigest }}</p>
      <p class="book-break">文件 {{ review.fileName }}</p>
      <button class="book-primary" type="button" :disabled="Boolean(job) || blocked" @click="commit">确认恢复到空账本</button>
    </div>
    <div v-if="pending" class="book-alert book-stack">
      <p class="book-break">原恢复任务 {{ pending.taskId }}。失败或中断后请按原任务号查询。</p>
      <button type="button" :disabled="Boolean(job) || blocked" @click="resume">核对原恢复任务</button>
    </div>
  </section>
  <RelationalOpenings v-if="workspace.reviewOpenings" :workspace="workspace" :native="controller.native" />
</template>

<script setup>
import { ref, shallowRef, computed, onScopeDispose } from 'vue';
import RelationalOpenings from './RelationalOpenings.vue';
const props = defineProps({ workspace: Object, controller: Object });
const message = ref(''), error = ref(''), job = shallowRef(null), review = shallowRef(null), pending = shallowRef(null), file = shallowRef(null);
const blocked = computed(() => props.workspace.state.pending || props.workspace.state.pendingError || props.workspace.state.busy);
let live = true;
onScopeDispose(() => { live = false; job.value?.abort(); void props.controller.forgetPreview?.(); });
function refreshPending() {
  try { pending.value = props.controller.pending(); }
  catch (cause) { error.value = cause.message; }
}
refreshPending();
async function doFile(work, done) {
  if (job.value) return;
  const controller = new AbortController(); job.value = controller; error.value = ''; message.value = '';
  try { const result = await work(controller.signal); if (live) await done(result); }
  catch (cause) { if (live && cause.name !== 'AbortError') error.value = cause.message; }
  finally { if (live) { job.value = null; refreshPending(); } }
}
function save() {
  void doFile(signal => props.controller.save({ signal }), value => {
    if (value.status === 'saved-verified') message.value = '外部文件已保存并读回核验：' + value.fileName + '，' + value.byteLength + ' 字节。';
  });
}
function choose(value) {
  review.value = null;
  void doFile(signal => props.controller.chooseRestore(value, { signal }), result => { if (result.status !== 'cancelled') review.value = result; });
}
function selected(event) {
  const selectedFile = event.target.files?.[0]; event.target.value = '';
  if (!selectedFile) return;
  if (pending.value) file.value = selectedFile; else choose(selectedFile);
}
function restore(id) {
  void doFile(signal => props.controller.restore(id, file.value, { signal }), async value => {
    if (value.status === 'cancelled') return;
    review.value = null; file.value = null; message.value = '原恢复回执已确认：' + value.memberCount + ' 位会员，' + value.entryCount + ' 笔流水。';
    await props.workspace.connect();
  });
}
function commit() { if (review.value && !blocked.value && globalThis.confirm('将这份已核对的备份恢复到新空账本？')) restore(review.value.taskId); }
function resume() { if (pending.value && !blocked.value) restore(pending.value.taskId); }
</script>
