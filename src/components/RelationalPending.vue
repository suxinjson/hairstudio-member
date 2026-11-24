<template>
  <aside v-if="pending || workspace.state.pendingError || message" class="book-panel book-alert" aria-label="账本待办">
    <p v-if="workspace.state.pendingError" role="alert">{{ workspace.state.pendingError }}</p>
    <template v-if="pending">
      <p><strong>{{ pending.rejection ? '原操作已拒绝' : '有一笔操作待确认' }}</strong> <code>{{ pending.id }}</code></p>
      <p v-if="pending.rejection">确认结束后，按最新资料重新核对。原请求没有入账。</p>
      <p v-else-if="obsolete">原操作属于旧代际。请用原单号与外部备份核对。这笔操作不会提交到新账本。</p>
      <p v-else-if="pending.local">只查询本机原回执。没有回执时会提示重新核对金额后操作。</p>
      <p v-else>先查原回执；若服务器尚无回执，会按原号提交同一请求。</p>
      <button v-if="pending.rejection" type="button" :disabled="workspace.state.busy" @click="finish">确认结束</button>
      <button v-else-if="!obsolete" type="button" :disabled="workspace.state.busy" @click="retry">按原号核对</button>
      <template v-else-if="canArchive">
        <label><input v-model="reviewed" type="checkbox" :disabled="workspace.state.busy"> 已核对原号，并交由店主处理原单</label>
        <button type="button" :disabled="workspace.state.busy || !reviewed" @click="archive">保存原单并结束待办</button>
      </template>
    </template>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </aside>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import { displayCents } from '../relational-presentation.js';
import { openPendingWriter } from '../relational-pending-files.js';
import { androidBackupDocuments } from '../android-backup-documents.js';
const props = defineProps({ workspace: { type: Object, required: true } });
const pending = computed(() => props.workspace.state.pending);
const target = computed(() => props.workspace.state.rebuildTarget?.ledgerEpoch ?? props.workspace.state.book?.ledgerEpoch);
const obsolete = computed(() => pending.value?.generationChanged || Boolean(!pending.value?.local && target.value && pending.value?.ledgerEpoch !== target.value));
const canArchive = computed(() => !pending.value?.local && props.workspace.archiveObsolete && (props.workspace.mode === 'cloud' || typeof globalThis.showSaveFilePicker === 'function'));
const reviewed = ref(false);
watch(() => [pending.value?.id, target.value], () => { reviewed.value = false; });
const message = ref(''), failed = ref(false);
async function act(action, completed) {
  message.value = ''; failed.value = false;
  try { message.value = completed(await action()); }
  catch (error) { failed.value = true; message.value = error.message; }
}
function retry() {
  void act(() => props.workspace.retryPending(), result => result?.uncommitted ? '本机原交易未提交。请重新核对后操作。' : result?.balanceAfterCents === undefined
    ? '已核对操作结果。' : '已取回原回执，原单余额 ¥' + displayCents(result.balanceAfterCents));
}
function finish() {
  const id = pending.value?.id;
  if (id && globalThis.confirm('确认结束这笔已拒绝的原操作？')) void act(() => props.workspace.acknowledgeRejected(id), () => '已结束原待办。');
}
function archive() {
  const id = pending.value?.id, epoch = target.value;
  if (!reviewed.value || !id || !epoch) return;
  void act(async () => {
    let save;
    try { save = props.workspace.mode === 'cloud' ? androidBackupDocuments().save : await openPendingWriter(id); }
    catch (error) { if (error.name === 'AbortError') return { reviewed: false }; throw error; }
    return props.workspace.archiveObsolete(id, epoch, save);
  }, result => { reviewed.value = false; return result.reviewed ? '已读回核验外部原单，并结束待办。' : ''; });
}
</script>
