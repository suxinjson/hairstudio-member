<template>
  <section class="book-panel book-stack" aria-label="本机同步">
    <div class="book-actions book-between">
      <p role="status">{{ label }}<template v-if="workspace.state.pendingCount"> · {{ workspace.state.pendingCount }} 笔待核对</template></p>
      <button type="button" :disabled="workspace.state.syncStatus === 'syncing' || workspace.state.blockedEpoch" @click="$emit('reconnect')">检查连接并同步</button>
    </div>
    <p v-if="workspace.state.blockedEpoch" class="book-alert" role="alert">{{ blockedMessage }}本机账本已暂停记账，请由店主核对原待办和备份。</p>
    <div v-if="workspace.state.blockedEpoch && workspace.state.syncError !== 'STORE_MISMATCH'" class="book-stack">
      <button type="button" :disabled="working || !online" @click="prepare">核对云端账本</button>
      <template v-if="target">
        <p class="book-break">云端账本代际：{{ target.ledgerEpoch }}。<template v-if="crossEpoch">旧单须和恢复后的流水或备份核对，再逐笔保存。</template></p>
        <p v-if="!crossEpoch && workspace.state.syncError === 'CURSOR_AHEAD'" role="alert">本机水位高于同代际云端水位，不能重建。请运维核对数据库目标和恢复记录。</p>
        <template v-if="canRebuild">
          <label><input v-model="confirmed" type="checkbox" :disabled="working"> 已核对原待办，同意用云端账本重建此手机副本</label>
          <div class="book-actions">
            <button type="button" :disabled="working || !online || !confirmed" @click="rebuild">重建本机副本</button>
            <button v-if="rebuilding" type="button" @click="workspace.cancelRebuild()">取消重建</button>
          </div>
          <p v-if="rebuilding" role="status">正在读取并核对云端流水…</p>
        </template>
      </template>
    </div>
    <ul v-if="workspace.state.pendingRows.length" class="book-list book-ledger-list">
      <li v-for="row in workspace.state.pendingRows" :key="row.id">
        <strong class="book-break">原单 {{ row.id }}</strong>
        <p v-if="row.errorCode === 'PENDING_ACTOR_CHANGED'">请使用提交该单的原账号核对。</p>
        <template v-else>
          <p>{{ row.status === 'conflict' ? '云端需要核对' : '等待云端确认' }} · 本机原单余额 ¥{{ displayCents(row.balanceAfterCents) }}</p>
          <div class="book-actions">
            <button type="button" :disabled="working" @click="detail(row.id)">查看原单</button>
            <button type="button" :disabled="working || !online || (workspace.state.blockedEpoch && !cursorBlocked)" @click="inspect(row.id)">向服务器查询原号</button>
            <button type="button" :disabled="working" @click="exportOriginal(row.id)">保存原单供核对</button>
          </div>
          <p v-if="crossEpoch && row.reviewedEpoch === target.ledgerEpoch">原单已保存并读回验证；重建时不会重新发送。</p>
          <div v-else-if="crossEpoch" class="book-actions">
            <label>核对结论<select v-model="decisions[row.id]" :disabled="working">
              <option value="">请选择</option>
              <option value="covered">原单金额已在云端或恢复记录中核对</option>
              <option value="manual">已登记，由店主人工作后续处理</option>
            </select></label>
            <button type="button" :disabled="working || !online || !decisions[row.id]" @click="review(row.id)">确认并保存原单</button>
          </div>
        </template>
      </li>
    </ul>
    <p v-if="message" :role="failed ? 'alert' : 'status'" class="book-break">{{ message }}</p>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { displayCents } from '../relational-presentation.js';
import { androidBackupDocuments } from '../android-backup-documents.js';
import { canonicalJSON } from '../canonical-json.js';
const props = defineProps({ workspace: Object, online: Boolean, owner: Boolean });
defineEmits(['reconnect']);
const working = ref(false), message = ref(''), failed = ref(false);
const confirmed = ref(false), rebuilding = ref(false), decisions = reactive({});
const target = computed(() => props.workspace.state.rebuildTarget);
const crossEpoch = computed(() => target.value && target.value.ledgerEpoch !== props.workspace.state.book?.ledgerEpoch);
const canRebuild = computed(() => props.owner && (crossEpoch.value || props.workspace.state.syncError === 'CURSOR_HISTORY_INCOMPLETE'));
const cursorBlocked = computed(() => ['CURSOR_AHEAD', 'CURSOR_HISTORY_INCOMPLETE'].includes(props.workspace.state.syncError));
watch(() => target.value?.ledgerEpoch, () => { confirmed.value = false; for (const id of Object.keys(decisions)) delete decisions[id]; });
const blockedMessage = computed(() => cursorBlocked.value
  ? '云端同步历史与本机水位不一致。' : '云端账本归属或代际已变化。');
const label = computed(() => {
  const state = props.workspace.state;
  if (state.blockedEpoch) return '账本需要店主核对';
  if (!state.replicaReady) return '请联网完成首次账本同步';
  if (!props.online) return '本机离线，交易先保存在此设备';
  if (state.syncStatus === 'syncing') return '正在同步';
  if (state.syncStatus === 'confirmed') return '云端已确认';
  return '本机账本，等待同步';
});
async function act(work) {
  if (working.value) return;
  working.value = true; message.value = ''; failed.value = false;
  try { message.value = await work(); }
  catch (error) { failed.value = true; message.value = error.message; }
  finally { working.value = false; }
}
function detail(id) {
  void act(async () => {
    const { command } = await props.workspace.pendingDetails(id);
    const type = { consume: '消费', recharge: '充值', reverse: '冲正' }[command.type];
    return type + ' · 会员编号 ' + command.memberId + ' · 原账户版本 ' + command.expectedAccountVersion + ' · 原代际 ' + command.ledgerEpoch +
      (command.actualPayCents ? ' · 实收 ¥' + displayCents(command.actualPayCents) + ' · 赠送 ¥' + displayCents(command.giftCents) : '') +
      (command.amountCents ? ' · 消费 ¥' + displayCents(command.amountCents) : '') +
      (command.originalEntryId ? ' · 对应流水 ' + command.originalEntryId : '');
  });
}
function inspect(id) {
  void act(async () => {
    const value = await props.workspace.inspectOriginal(id);
    if (value.status === 'confirmed') return '已找回原回执，确认余额 ¥' + displayCents(value.result.balanceAfterCents);
    if (value.status === 'not-found') return '服务器当前没有这笔原回执。原待办仍保留，请核对后再处理。';
    return '当前账本无法确认这笔原单，请由店主核对。';
  });
}
function exportOriginal(id) {
  void act(async () => {
    const original = await props.workspace.pendingDetails(id);
    const result = await androidBackupDocuments().save({ content: canonicalJSON({ format: 'member-pending-review', ...original }), fileName: 'member-pending-' + id + '.json' });
    return result.status === 'saved-verified' ? '已将原单保存到外部文件并读回核验。本机仍保留原单。' : '';
  });
}
function prepare() { void act(async () => { await props.workspace.prepareRebuild(); return ''; }); }
function review(id) {
  const epoch = target.value.ledgerEpoch, resolution = decisions[id];
  void act(async () => {
    const result = await props.workspace.savePendingReview(id, resolution, epoch, androidBackupDocuments());
    return result.reviewed ? '已核对并保存原单。本机原单在副本重建成功之前仍保留。' : '';
  });
}
function rebuild() {
  if (!confirmed.value || !target.value || !canRebuild.value) return;
  const epoch = target.value.ledgerEpoch;
  void act(async () => {
    rebuilding.value = true;
    try {
      const value = await props.workspace.rebuildReplica(epoch);
      return '本机副本已重建：' + value.memberCount + ' 位会员、' + value.entryCount + ' 笔云端流水。';
    } finally { rebuilding.value = false; confirmed.value = false; }
  });
}
</script>
