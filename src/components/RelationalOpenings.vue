<template>
  <details class="book-panel book-stack" @toggle="closed">
    <summary>新空账本 · 期初余额</summary>
    <p>使用停写后核对的会员候选文件和两份 SHA-256 摘要。期初余额不会记作充值或收入。</p>
    <p v-if="pending" class="book-break" role="status">原批次 {{ pending.batchId }} · 原代际 {{ pending.ledgerEpoch }}。{{ stale ? '目标已换代，请保留文件并交由店主核对。' : '重选同一份文件、填入原摘要可按原批次续办。' }}</p>
    <div class="book-fields">
      <label>原始来源摘要<input v-model.trim="sourceDigest" maxlength="64" autocomplete="off" :disabled="working || stale" @input="reset"></label>
      <label>候选内容摘要<input v-model.trim="payloadDigest" maxlength="64" autocomplete="off" :disabled="working || stale" @input="reset"></label>
    </div>
    <button v-if="native" type="button" :disabled="!canRead" @click="choose()">选择并核对期初文件</button>
    <label v-else>选择并核对期初文件<input type="file" accept=".json,application/json" :disabled="!canRead" @change="selected"></label>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="review" class="book-stack">
      <p class="book-break">目标门店 {{ workspace.state.book.storeId }} · 账本代际 {{ review.ledgerEpoch }} · 批次 {{ review.batchId }}</p>
      <p>{{ review.memberCount }} 人 · 储值合计 ¥{{ displayCents(review.positiveBalanceCents) }} · 欠款合计 ¥{{ displayCents(review.negativeBalanceCents) }} · 净额 ¥{{ displayCents(review.netBalanceCents) }} · 负余额 {{ review.negativeBalanceCount }} 人 · 零余额 {{ review.zeroBalanceCount }} 人</p>
      <ol class="book-list">
        <li v-for="row in review.members" :key="row.id" class="book-break">
          <strong>{{ row.name }} · ¥{{ displayCents(row.balanceCents) }}</strong>
          <p>编号 {{ row.id }}{{ row.sourceMemberId && row.sourceMemberId !== row.id ? ' · 原编号 ' + row.sourceMemberId : '' }} · {{ row.phone || '未留手机号' }}</p>
          <p v-if="row.notes || row.tags.length">{{ row.notes }} {{ row.tags.join('、') }}</p>
        </li>
      </ol>
      <label class="book-inline"><input v-model="approved" type="checkbox" :disabled="working">旧账本已停写，已逐人核对档案和余额并验证外部备份</label>
      <button type="button" class="book-primary" :disabled="!approved || working || blocked || stale" @click="submit">确认导入期初</button>
    </div>
  </details>
</template>

<script setup>
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { androidBackupDocuments } from '../android-backup-documents.js';
import { createOpeningFiles, OPENING_FILE_LIMIT } from '../relational-openings.js';
import { displayCents } from '../relational-presentation.js';

const props = defineProps({ workspace: { type: Object, required: true }, native: Boolean });
const files = createOpeningFiles(props.workspace);
const review = shallowRef(null), pending = shallowRef(null);
const working = ref(false), error = ref(''), message = ref(''), approved = ref(false);
const sourceDigest = ref(''), payloadDigest = ref('');
const blocked = computed(() => props.workspace.state.busy || props.workspace.state.pending || props.workspace.state.pendingError);
const stale = computed(() => pending.value && pending.value.ledgerEpoch !== props.workspace.state.book?.ledgerEpoch);
const canRead = computed(() => !working.value && !blocked.value && !stale.value && /^[a-f0-9]{64}$/.test(sourceDigest.value) && /^[a-f0-9]{64}$/.test(payloadDigest.value));
let live = true;
function reset() { files.clear(); review.value = null; approved.value = false; error.value = ''; message.value = ''; }
function refresh() { try { pending.value = files.pending(); } catch (cause) { error.value = cause.message; } }
refresh();
if (pending.value) { sourceDigest.value = pending.value.sourceDigest; payloadDigest.value = pending.value.payloadDigest; }
onScopeDispose(() => { live = false; files.clear(); });
function closed(event) { if (!event.currentTarget.open && !working.value) reset(); }
function selected(event) { const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file); }
async function choose(file) {
  if (!canRead.value) return;
  reset(); working.value = true;
  try {
    let content;
    if (props.native) {
      const value = await androidBackupDocuments().open({ maxBytes: OPENING_FILE_LIMIT });
      if (value.status === 'cancelled') return;
      content = value.content;
    } else {
      if (!file || file.size < 1 || file.size > OPENING_FILE_LIMIT) throw new Error('期初文件为空或超出 4 MiB 上限');
      content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    }
    if (!live) return;
    const value = await files.review(content, { sourceDigest: sourceDigest.value, payloadDigest: payloadDigest.value });
    if (live) review.value = value;
  } catch (cause) { if (live) error.value = cause.message; }
  finally { if (live) { working.value = false; refresh(); } }
}
async function submit() {
  if (!review.value || !approved.value || working.value || blocked.value || stale.value) return;
  working.value = true; error.value = '';
  try {
    const result = await files.submit();
    if (live) { reset(); message.value = '原期初批次已确认：' + result.memberCount + ' 人。'; }
  } catch (cause) { if (live) { approved.value = false; error.value = cause.message; } }
  finally { if (live) { working.value = false; refresh(); } }
}
</script>
