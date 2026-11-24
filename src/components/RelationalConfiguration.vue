<template>
  <section class="book-stack" aria-label="服务与充值设置">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <button v-if="!form" type="button" :disabled="busy" @click="load">加载配置</button>
    <form v-else class="book-panel book-stack" @submit.prevent="save">
      <p>修改只对以后成交生效。已入账交易保留原价格和赠送规则。</p>
      <fieldset :disabled="!owner || busy || workspace.state.busy" class="book-stack">
        <legend>服务项目</legend>
        <div v-for="(row, index) in form.services" :key="row.id" class="book-fields">
          <label>名称<input v-model.trim="row.name" maxlength="128" required></label>
          <label>单价（元）<input v-model.trim="row.price" inputmode="decimal" required></label>
          <button type="button" @click="form.services.splice(index, 1)">停用</button>
        </div>
        <button type="button" :disabled="form.services.length >= 500" @click="addService">添加服务项目</button>
      </fieldset>
      <fieldset :disabled="!owner || busy || workspace.state.busy" class="book-stack">
        <legend>充值套餐及赠送</legend>
        <label class="book-inline"><input v-model="form.giftEnabled" type="checkbox">启用充值赠送</label>
        <label>赠送比例（%）<input v-model.trim="form.rate" inputmode="decimal" placeholder="例如 10.00" required></label>
        <div v-for="(row, index) in form.plans" :key="row.id" class="book-fields">
          <label>套餐实收（元）<input v-model.trim="row.pay" inputmode="decimal" required></label>
          <label>套餐赠送（元）<input v-model.trim="row.gift" inputmode="decimal" required></label>
          <button type="button" @click="form.plans.splice(index, 1)">停用</button>
        </div>
        <button type="button" :disabled="form.plans.length >= 200" @click="addPlan">添加充值套餐</button>
      </fieldset>
      <div class="book-actions">
        <button v-if="owner" class="book-primary" type="submit" :disabled="blocked">保存配置</button>
        <button type="button" :disabled="busy || workspace.state.busy" @click="void reload()">重读配置</button>
      </div>
    </form>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, onMounted, onScopeDispose } from 'vue';
import { displayCents, yuanCents } from '../relational-presentation.js';
const props = defineProps({ workspace: Object, owner: Boolean });
const form = ref(null), scope = shallowRef(null), error = ref(''), message = ref(''), busy = ref(false);
const blocked = computed(() => busy.value || !props.workspace.state.book || props.workspace.state.busy || props.workspace.state.pending || props.workspace.state.pendingError);
let alive = true;
onScopeDispose(() => { alive = false; });
function assign(config) {
  form.value = { version: config.version, giftEnabled: config.rechargeSettings.giftEnabled, rate: displayCents(String(config.rechargeSettings.giftRateBasisPoints)),
    services: config.services.map(row => ({ id: row.id, name: row.name, price: displayCents(row.priceCents) })),
    plans: config.rechargePlans.map(row => ({ id: row.id, pay: displayCents(row.payCents), gift: displayCents(row.giftCents) })) };
}
async function load() {
  busy.value = true; error.value = ''; message.value = ''; const captured = props.workspace.getScope();
  try { const config = await props.workspace.read('getConfiguration'); if (alive) { scope.value = captured; assign(config); } }
  catch (cause) { if (alive) error.value = cause.message; }
  finally { busy.value = false; }
}
function reload() { if (globalThis.confirm('从账本重新读取配置？当前未保存的编辑将清除。')) return load(); }
function addService() { form.value.services.push({ id: crypto.randomUUID(), name: '', price: '' }); }
function addPlan() { form.value.plans.push({ id: crypto.randomUUID(), pay: '', gift: '0' }); }
async function save() {
  if (blocked.value || !props.owner) return;
  error.value = ''; message.value = ''; busy.value = true;
  try {
    const { version, rate, giftEnabled, services, plans } = form.value, basisPoints = Number(yuanCents(rate));
    if (!Number.isSafeInteger(basisPoints) || basisPoints > 10000) throw new Error('赠送比例须为 0–100%');
    const data = { expectedVersion: version, rechargeSettings: { giftEnabled, giftRateBasisPoints: basisPoints },
      services: services.map(row => ({ id: row.id, name: row.name, priceCents: yuanCents(row.price) })),
      rechargePlans: plans.map(row => ({ id: row.id, payCents: yuanCents(row.pay, { positive: true }), giftCents: yuanCents(row.gift) })) };
    const saved = await props.workspace.submit('task', { type: 'configuration.update', data }, scope.value);
    if (alive) { assign(saved); message.value = '配置已保存。'; }
  } catch (cause) { if (alive) error.value = cause.message; }
  finally { busy.value = false; }
}
onMounted(load);
</script>
