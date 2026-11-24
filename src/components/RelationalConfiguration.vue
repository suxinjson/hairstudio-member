<template>
  <section class="book-stack" aria-label="服务与充值设置">
    <p v-if="error" class="book-panel book-alert" role="alert">{{ error }}</p>
    <p v-if="message" class="book-panel" style="background: #f0fdf4; border-color: #bbf7d0; color: #166534;" role="status">{{ message }}</p>
    
    <div v-if="!form" class="book-panel book-stack" style="text-align: center; padding: 2rem 1rem;">
      <p style="margin: 0; color: #64748b;">需要查看或调整店内服务定价与充值套餐规则？</p>
      <button type="button" class="book-primary" :disabled="busy" @click="load" style="margin: 0.5rem auto 0; min-height: 2.75rem; padding: 0.5rem 1.5rem;">
        加载配置
      </button>
    </div>

    <form v-else class="book-panel book-stack" @submit.prevent="save" style="padding: 1.125rem 1.25rem;">
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.75rem 1rem;">
        <p style="margin: 0; font-size: 0.8125rem; color: #64748b; line-height: 1.45;">
          💡 <strong>定价说明：</strong>修改只对以后新发起的成交生效。已入账的历史流水严格保留当时的成交价格和赠送规则。
        </p>
      </div>

      <!-- 常用服务项目配置 -->
      <fieldset :disabled="!owner || busy || workspace.state.busy" class="book-stack" style="border: none; padding: 0; margin: 0;">
        <legend style="font-size: 1.05rem; font-weight: 750; color: #123c32; margin-bottom: 0.5rem;">服务项目</legend>
        <div v-for="(row, index) in form.services" :key="row.id" class="book-fields"
          style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.75rem; margin-bottom: 0.25rem;">
          <label>名称<input v-model.trim="row.name" maxlength="128" placeholder="项目名称（如剪发、染发）" required></label>
          <label>单价（元）<input v-model.trim="row.price" inputmode="decimal" placeholder="0.00" required></label>
          <button type="button" class="book-btn" @click="form.services.splice(index, 1)" style="min-height: 2.75rem; color: #dc2626; border-color: #fecdd3; background: #fff5f5;">
            停用
          </button>
        </div>
        <button type="button" class="book-btn" :disabled="form.services.length >= 500" @click="addService" style="min-height: 2.75rem;">
          ＋ 添加服务项目
        </button>
      </fieldset>

      <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 0.5rem 0;">

      <!-- 充值套餐及赠送设置 -->
      <fieldset :disabled="!owner || busy || workspace.state.busy" class="book-stack" style="border: none; padding: 0; margin: 0;">
        <legend style="font-size: 1.05rem; font-weight: 750; color: #123c32; margin-bottom: 0.5rem;">充值套餐及赠送</legend>
        <label class="book-inline" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.625rem 0.875rem; cursor: pointer;">
          <input v-model="form.giftEnabled" type="checkbox">
          <span style="font-weight: 700; color: #1e293b;">启用充值赠送功能</span>
        </label>
        <label>赠送比例（%）
          <input v-model.trim="form.rate" inputmode="decimal" placeholder="例如 10.00" required>
        </label>
        <div v-for="(row, index) in form.plans" :key="row.id" class="book-fields"
          style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 0.75rem; margin-bottom: 0.25rem;">
          <label>套餐实收（元）<input v-model.trim="row.pay" inputmode="decimal" placeholder="0.00" required></label>
          <label>套餐赠送（元）<input v-model.trim="row.gift" inputmode="decimal" placeholder="0.00" required></label>
          <button type="button" class="book-btn" @click="form.plans.splice(index, 1)" style="min-height: 2.75rem; color: #dc2626; border-color: #fecdd3; background: #fff5f5;">
            停用
          </button>
        </div>
        <button type="button" class="book-btn" :disabled="form.plans.length >= 200" @click="addPlan" style="min-height: 2.75rem;">
          ＋ 添加充值套餐
        </button>
      </fieldset>

      <!-- 操作保存栏 -->
      <div class="book-actions" style="margin-top: 0.75rem; border-top: 1px solid #f1f5f9; padding-top: 0.875rem;">
        <button v-if="owner" class="book-primary" type="submit" :disabled="blocked" style="flex: 1; min-height: 2.875rem; font-size: 1rem;">
          保存配置
        </button>
        <button type="button" class="book-btn" :disabled="busy || workspace.state.busy" @click="void reload()" style="min-height: 2.875rem;">
          重读配置
        </button>
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
  form.value = {
    version: config.version, giftEnabled: config.rechargeSettings.giftEnabled,
    rate: displayCents(String(config.rechargeSettings.giftRateBasisPoints)),
    services: config.services.map(row => ({ id: row.id, name: row.name, price: displayCents(row.priceCents) })),
    plans: config.rechargePlans.map(row => ({ id: row.id, pay: displayCents(row.payCents), gift: displayCents(row.giftCents) }))
  };
}

async function load() {
  busy.value = true; error.value = ''; message.value = ''; const captured = props.workspace.getScope();
  try {
    const config = await props.workspace.read('getConfiguration');
    if (alive) { scope.value = captured; assign(config); }
  } catch (cause) {
    if (alive) error.value = cause.message;
  } finally {
    busy.value = false;
  }
}

function reload() {
  if (globalThis.confirm('从账本重新读取配置？当前未保存的编辑将清除。')) return load();
}

function addService() {
  form.value.services.push({ id: crypto.randomUUID(), name: '', price: '' });
}

function addPlan() {
  form.value.plans.push({ id: crypto.randomUUID(), pay: '', gift: '0' });
}

async function save() {
  if (blocked.value || !props.owner) return;
  error.value = ''; message.value = ''; busy.value = true;
  try {
    const { version, rate, giftEnabled, services, plans } = form.value, basisPoints = Number(yuanCents(rate));
    if (!Number.isSafeInteger(basisPoints) || basisPoints > 10000) throw new Error('赠送比例须为 0–100%');
    const data = {
      expectedVersion: version, rechargeSettings: { giftEnabled, giftRateBasisPoints: basisPoints },
      services: services.map(row => ({ id: row.id, name: row.name, priceCents: yuanCents(row.price) })),
      rechargePlans: plans.map(row => ({ id: row.id, payCents: yuanCents(row.pay, { positive: true }), giftCents: yuanCents(row.gift) }))
    };
    const saved = await props.workspace.submit('task', { type: 'configuration.update', data }, scope.value);
    if (alive) { assign(saved); message.value = '配置已保存。'; }
  } catch (cause) {
    if (alive) error.value = cause.message;
  } finally {
    busy.value = false;
  }
}
</script>
