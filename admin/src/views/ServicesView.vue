<template>
  <div class="space-y-6">
    <!-- 服务项目维护卡片 -->
    <div class="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-6">
      <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
        <div>
          <h3 class="font-black text-slate-900 text-base">💇 美发服务项目与定价</h3>
          <p class="text-xs text-slate-400 mt-0.5">收银扣款时可直接勾选的项目与默认标准价格</p>
        </div>
        <button
          @click="openAddService"
          class="h-9 px-3.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black transition flex items-center gap-1"
        >
          <span>＋</span> 添加服务项目
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <div
          v-for="s in services"
          :key="s.id"
          class="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 flex items-center justify-between"
        >
          <div>
            <div class="font-black text-slate-900 text-sm">{{ s.name }}</div>
            <div class="text-xs font-black text-emerald-700 mt-0.5">
              标准定价：¥{{ (s.price / 100).toFixed(2) }}
            </div>
          </div>
          <button
            @click="openEditService(s)"
            class="px-2.5 py-1 text-xs font-bold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
          >
            编辑
          </button>
        </div>
      </div>
    </div>

    <!-- 充值赠送方案卡片 -->
    <div class="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-6">
      <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
        <div>
          <h3 class="font-black text-slate-900 text-base">🎁 储值卡充值赠送档位方案</h3>
          <p class="text-xs text-slate-400 mt-0.5">前台会员充值时一键选择的实付与赠送配比</p>
        </div>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div
          v-for="p in rechargePlans"
          :key="`${p.pay}_${p.gift}`"
          class="p-4 rounded-2xl border border-emerald-100 bg-emerald-50/40 text-center"
        >
          <div class="text-xs text-slate-500 font-bold">充值档位</div>
          <div class="text-xl font-black text-slate-900 mt-1">¥{{ (p.pay / 100).toFixed(0) }}</div>
          <div class="text-xs font-black text-emerald-700 mt-1">
            送 ¥{{ (p.gift / 100).toFixed(0) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 编辑服务弹窗 -->
    <div v-if="editingService" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-slate-100">
        <h3 class="text-lg font-black text-slate-900 mb-4">{{ editingService.id ? '编辑服务项目' : '添加服务项目' }}</h3>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">服务项目名称 *</label>
            <input
              v-model="serviceForm.name"
              type="text"
              placeholder="如：总监精剪"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">标准价格 (元) *</label>
            <input
              v-model="serviceForm.priceStr"
              type="number"
              step="0.01"
              placeholder="0.00"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
        </div>

        <div class="mt-6 flex gap-2.5">
          <button
            @click="editingService = null"
            class="flex-1 h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-sm hover:bg-slate-200"
          >
            取消
          </button>
          <button
            @click="saveService"
            :disabled="!serviceForm.name.trim() || !Number(serviceForm.priceStr)"
            class="flex-1 h-11 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-sm disabled:opacity-50"
          >
            保存项目
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
  services: { type: Array, default: () => [] },
  rechargePlans: { type: Array, default: () => [] }
});

const emit = defineEmits(['sync-operations']);

const editingService = ref(null);
const serviceForm = ref({ name: '', priceStr: '' });

function openAddService() {
  editingService.value = {};
  serviceForm.value = { name: '', priceStr: '' };
}

function openEditService(s) {
  editingService.value = s;
  serviceForm.value = {
    name: s.name,
    priceStr: (s.price / 100).toFixed(2)
  };
}

function saveService() {
  const name = serviceForm.value.name.trim();
  const price = Math.round(Number(serviceForm.priceStr) * 100);
  if (!name || isNaN(price)) return;

  const opId = 'op-srv-' + Date.now().toString(36);
  const op = {
    id: opId,
    method: 'saveService',
    args: [{
      id: editingService.value.id || ('S' + Date.now().toString(36)),
      name,
      price
    }],
    generated: { ids: [opId], times: [new Date().toISOString()] }
  };
  emit('sync-operations', [op]);
  editingService.value = null;
}
</script>
