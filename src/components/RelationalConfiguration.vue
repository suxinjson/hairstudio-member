<template>
  <section class="space-y-4 max-w-2xl mx-auto pb-10" aria-label="服务与充值设置">
    <!-- 提示与状态信息 -->
    <div v-if="error" class="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs font-bold flex items-start gap-2 shadow-xs" role="alert">
      <span class="text-base leading-none">⚠️</span>
      <span class="flex-1 leading-relaxed">{{ error }}</span>
    </div>
    <div v-if="message" class="p-3.5 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-start gap-2 shadow-xs" role="status">
      <span class="text-base leading-none">✅</span>
      <span class="flex-1 leading-relaxed">{{ message }}</span>
    </div>

    <!-- 加载中占位 -->
    <div v-if="!form && busy" class="p-12 text-center bg-white border border-slate-200/90 rounded-2xl shadow-xs">
      <div class="inline-block animate-spin text-2xl mb-2">⏳</div>
      <p class="text-xs text-slate-500 font-bold m-0">正在从数据库加载店内配置…</p>
    </div>

    <!-- 未加载时的提示与手动加载按钮 -->
    <div v-else-if="!form" class="p-8 text-center bg-white border border-slate-200/90 rounded-2xl shadow-xs space-y-3">
      <p class="text-xs text-slate-600 font-bold m-0">需要查看或调整店内服务定价与充值套餐规则？</p>
      <button
        type="button"
        class="h-10 px-5 bg-emerald-700 text-white text-xs font-bold rounded-xl btn-press disabled:opacity-50"
        :disabled="busy"
        @click="load"
      >
        加载配置
      </button>
    </div>

    <!-- 配置表单 -->
    <form v-else class="space-y-4" @submit.prevent="save">
      <!-- 定价与规则说明 -->
      <div class="p-3.5 rounded-2xl bg-slate-50 border border-slate-200/80 text-slate-600 text-xs leading-relaxed flex items-start gap-2">
        <span class="text-base leading-none shrink-0">💡</span>
        <div class="min-w-0">
          <strong class="text-slate-800">定价说明：</strong>
          修改只对以后新发起的成交生效。已入账的历史流水严格保留当时的成交价格和赠送规则，确保商业账目安全合规。
        </div>
      </div>

      <!-- 1. 常用服务项目配置 -->
      <fieldset :disabled="!owner || busy || workspace.state.busy" class="bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3.5">
        <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <legend class="text-sm sm:text-base font-black text-slate-900 m-0 flex items-center gap-1.5">
            <span>🛍️ 服务项目定价</span>
            <span class="text-xs font-bold text-slate-400">({{ form.services.length }})</span>
          </legend>
          <span class="text-[11px] text-slate-400 font-medium">前台收银可一键点选填入</span>
        </div>

        <div v-if="!form.services.length" class="text-center py-6 text-xs text-slate-400 font-bold">
          暂无常用服务项目，点击下方添加
        </div>

        <div class="space-y-2">
          <div
            v-for="(row, index) in form.services"
            :key="row.id"
            class="flex items-center gap-2 p-2.5 bg-slate-50 border border-slate-200/80 rounded-xl transition-all"
          >
            <div class="flex-1 min-w-0">
              <label class="sr-only">服务项目名称</label>
              <input
                v-model.trim="row.name"
                maxlength="128"
                placeholder="项目名称（如剪发、染发）"
                required
                class="w-full h-10 px-3 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800 focus:border-emerald-600 outline-none"
              />
            </div>
            <div class="w-28 sm:w-32 shrink-0">
              <label class="sr-only">单价（元）</label>
              <div class="flex items-center bg-white border border-slate-200 rounded-lg px-2.5 h-10 focus-within:border-emerald-600">
                <span class="text-slate-400 font-black text-xs mr-1 shrink-0 select-none">¥</span>
                <input
                  v-model.trim="row.price"
                  inputmode="decimal"
                  placeholder="0.00"
                  required
                  class="w-full bg-transparent border-0 outline-none p-0 text-xs font-black text-slate-900 tabular-nums focus:ring-0"
                />
              </div>
            </div>
            <button
              type="button"
              @click="form.services.splice(index, 1)"
              class="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 flex items-center justify-center text-xs font-bold btn-press shrink-0"
              aria-label="移除此服务项目"
            >
              ✕
            </button>
          </div>
        </div>

        <button
          type="button"
          :disabled="form.services.length >= 500"
          @click="addService"
          class="w-full h-10 rounded-xl border border-dashed border-slate-300 hover:border-emerald-600 text-slate-600 hover:text-emerald-700 text-xs font-bold flex items-center justify-center gap-1 transition-colors btn-press"
        >
          <span>＋ 添加服务项目</span>
        </button>
      </fieldset>

      <!-- 2. 充值套餐及赠送设置 -->
      <fieldset :disabled="!owner || busy || workspace.state.busy" class="bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs space-y-3.5">
        <div class="flex items-center justify-between border-b border-slate-100 pb-2.5">
          <legend class="text-sm sm:text-base font-black text-slate-900 m-0">
            🎁 充值套餐及赠送
          </legend>
          <span class="text-[11px] text-slate-400 font-medium">配置会员充值返赠规则</span>
        </div>

        <!-- 启用/关闭赠送总开关 -->
        <label class="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 cursor-pointer select-none transition-colors hover:bg-slate-100/70">
          <div class="space-y-0.5 pr-2">
            <span class="text-xs sm:text-sm font-black text-slate-900 block">启用充值赠送功能</span>
            <span class="text-[11px] text-slate-500 font-medium block">
              {{ form.giftEnabled ? '开启后会员充值可享受比例返赠或套餐赠额' : '关闭后充值将仅按实收金额入账，不额外赠送额度' }}
            </span>
          </div>
          <input
            v-model="form.giftEnabled"
            type="checkbox"
            class="w-5 h-5 rounded-md text-emerald-600 accent-emerald-600 shrink-0 cursor-pointer"
          />
        </label>

        <!-- 全局赠送比例 (仅开启赠送时显示) -->
        <div v-if="form.giftEnabled" class="p-3 bg-emerald-50/60 border border-emerald-200/70 rounded-xl space-y-1.5 animate-fade-in">
          <div class="flex items-center justify-between text-xs font-bold text-emerald-950">
            <span>默认赠送比例</span>
            <span class="text-[11px] text-emerald-700 font-medium">手工输入金额时自动折算赠送</span>
          </div>
          <div class="flex items-center bg-white border border-emerald-300 rounded-lg px-3 h-10 focus-within:border-emerald-600">
            <input
              v-model.trim="form.rate"
              inputmode="decimal"
              placeholder="例如 10.00"
              :required="form.giftEnabled"
              class="w-full bg-transparent border-0 outline-none p-0 text-xs font-black text-slate-900 tabular-nums focus:ring-0"
            />
            <span class="text-emerald-800 font-bold text-xs shrink-0 select-none ml-1">%</span>
          </div>
        </div>

        <!-- 快捷充值套餐列表 -->
        <div class="space-y-2">
          <div class="flex items-center justify-between text-xs font-bold text-slate-700">
            <span>充值套餐列表</span>
            <span class="text-[11px] text-slate-400">({{ form.plans.length }})</span>
          </div>

          <div v-if="!form.plans.length" class="text-center py-6 text-xs text-slate-400 font-bold">
            暂无充值套餐，点击下方添加
          </div>

          <div
            v-for="(row, index) in form.plans"
            :key="row.id"
            class="flex items-center gap-2 p-2.5 bg-slate-50 border border-slate-200/80 rounded-xl transition-all"
          >
            <div class="flex-1 min-w-0">
              <label class="text-[10px] text-slate-500 font-bold block mb-0.5">套餐实收（元）</label>
              <div class="flex items-center bg-white border border-slate-200 rounded-lg px-2.5 h-10 focus-within:border-emerald-600">
                <span class="text-slate-400 font-black text-xs mr-1 shrink-0 select-none">¥</span>
                <input
                  v-model.trim="row.pay"
                  inputmode="decimal"
                  placeholder="0.00"
                  required
                  class="w-full bg-transparent border-0 outline-none p-0 text-xs font-black text-slate-900 tabular-nums focus:ring-0"
                />
              </div>
            </div>

            <!-- 仅在开启赠送时显示套餐赠送金额 -->
            <div v-if="form.giftEnabled" class="w-28 sm:w-36 shrink-0 animate-fade-in">
              <label class="text-[10px] text-emerald-700 font-bold block mb-0.5">赠送额度（元）</label>
              <div class="flex items-center bg-white border border-slate-200 rounded-lg px-2.5 h-10 focus-within:border-emerald-600">
                <span class="text-emerald-600 font-black text-xs mr-1 shrink-0 select-none">¥</span>
                <input
                  v-model.trim="row.gift"
                  inputmode="decimal"
                  placeholder="0.00"
                  :required="form.giftEnabled"
                  class="w-full bg-transparent border-0 outline-none p-0 text-xs font-black text-emerald-800 tabular-nums focus:ring-0"
                />
              </div>
            </div>

            <button
              type="button"
              @click="form.plans.splice(index, 1)"
              class="w-8 h-8 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 flex items-center justify-center text-xs font-bold btn-press shrink-0 self-end mb-1"
              aria-label="移除此充值套餐"
            >
              ✕
            </button>
          </div>
        </div>

        <button
          type="button"
          :disabled="form.plans.length >= 200"
          @click="addPlan"
          class="w-full h-10 rounded-xl border border-dashed border-slate-300 hover:border-emerald-600 text-slate-600 hover:text-emerald-700 text-xs font-bold flex items-center justify-center gap-1 transition-colors btn-press"
        >
          <span>＋ 添加充值套餐</span>
        </button>
      </fieldset>

      <!-- 操作保存栏 -->
      <div class="pt-2 flex items-center gap-2.5">
        <button
          v-if="owner"
          type="submit"
          :disabled="blocked"
          class="flex-1 h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl font-black text-sm sm:text-base shadow-md shadow-emerald-500/20 flex items-center justify-center gap-1.5 btn-press disabled:opacity-50"
        >
          <span v-if="busy">正在保存到数据库…</span>
          <span v-else>💾 保存配置</span>
        </button>

        <button
          type="button"
          :disabled="busy || workspace.state.busy"
          @click="void reload()"
          class="h-12 px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-bold btn-press shrink-0"
        >
          🔄 重读配置
        </button>
      </div>
    </form>
  </section>
</template>

<script setup>
import { ref, shallowRef, computed, onMounted, onScopeDispose, watch } from 'vue';
import { displayCents, yuanCents } from '../relational-presentation.js';

const props = defineProps({ workspace: Object, owner: Boolean });
const form = ref(null), scope = shallowRef(null), error = ref(''), message = ref(''), busy = ref(false);
const blocked = computed(() => busy.value || !props.workspace.state.book || props.workspace.state.busy || props.workspace.state.pending || props.workspace.state.pendingError);

let alive = true;
onScopeDispose(() => { alive = false; });

function assign(config) {
  form.value = {
    version: config.version,
    giftEnabled: Boolean(config.rechargeSettings?.giftEnabled),
    rate: displayCents(String(config.rechargeSettings?.giftRateBasisPoints ?? 0)),
    services: (config.services || []).map(row => ({
      id: row.id,
      name: row.name,
      price: displayCents(row.priceCents)
    })),
    plans: (config.rechargePlans || []).map(row => ({
      id: row.id,
      pay: displayCents(row.payCents),
      gift: displayCents(row.giftCents)
    }))
  };
}

async function load() {
  busy.value = true;
  error.value = '';
  message.value = '';
  const captured = props.workspace.getScope?.();
  try {
    const config = await props.workspace.read('getConfiguration');
    if (alive) {
      scope.value = captured;
      assign(config);
    }
  } catch (cause) {
    if (alive) error.value = cause.message;
  } finally {
    if (alive) busy.value = false;
  }
}

// 自动在挂载与账本变更时加载配置
onMounted(() => {
  void load();
});

watch(
  () => props.workspace?.state?.book,
  (book) => {
    if (book && !form.value) {
      void load();
    }
  }
);

function reload() {
  if (globalThis.confirm('从数据库重新读取配置？当前未保存的编辑将清除。')) {
    return load();
  }
}

function addService() {
  if (!form.value) return;
  form.value.services.push({ id: crypto.randomUUID(), name: '', price: '' });
}

function addPlan() {
  if (!form.value) return;
  form.value.plans.push({ id: crypto.randomUUID(), pay: '', gift: '0' });
}

async function save() {
  if (blocked.value || !props.owner || !form.value) return;
  error.value = '';
  message.value = '';
  busy.value = true;
  try {
    const { version, rate, giftEnabled, services, plans } = form.value;
    const isGift = Boolean(giftEnabled);
    let basisPoints = 0;
    if (isGift) {
      basisPoints = Number(yuanCents(rate || '0'));
      if (!Number.isSafeInteger(basisPoints) || basisPoints < 0 || basisPoints > 10000) {
        throw new Error('赠送比例须为 0–100%');
      }
    }

    const data = {
      expectedVersion: version,
      rechargeSettings: {
        giftEnabled: isGift,
        giftRateBasisPoints: basisPoints
      },
      services: services.map(row => ({
        id: row.id,
        name: row.name.trim(),
        priceCents: yuanCents(row.price)
      })),
      rechargePlans: plans.map(row => ({
        id: row.id,
        payCents: yuanCents(row.pay, { positive: true }),
        // 关键防护：当关闭充值赠送时，强制套餐 giftCents 为 '0'，确保符合后端约束并成功持久化存入数据库
        giftCents: isGift ? yuanCents(row.gift || '0') : '0'
      }))
    };

    const targetScope = scope.value || props.workspace.getScope?.();
    const saved = await props.workspace.submit('task', { type: 'configuration.update', data }, targetScope);
    if (alive) {
      assign(saved);
      message.value = '配置已保存成功，已同步存入数据库。';
    }
  } catch (cause) {
    if (alive) error.value = cause.message;
  } finally {
    if (alive) busy.value = false;
  }
}
</script>
