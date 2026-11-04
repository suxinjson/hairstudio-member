<template>
  <div class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
    <div class="flex items-center justify-between pb-3.5 border-b border-slate-100">
      <div>
        <h2 class="font-black text-slate-900 text-lg">💈 服务项目与定价设置</h2>
        <p class="text-xs text-slate-400 font-medium mt-0.5">收银扣款时可一键带入常用项目与金额</p>
      </div>
      <button 
        @click="emit('add')"
        :disabled="!canWrite('saveService')"
        class="h-11 bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-4 rounded-xl font-black shadow-sm btn-press"
      >
        + 新增项目
      </button>
    </div>

    <div class="divide-y divide-slate-100 mt-1">
      <div 
        v-for="s in services" 
        :key="s.id"
        class="py-3.5 flex items-center justify-between text-sm"
      >
        <div>
          <span class="font-black text-slate-900 text-base">{{ s.name }}</span>
          <span class="text-indigo-600 font-black ml-2.5 text-base">¥ {{ s.price }}</span>
        </div>
        <div class="flex space-x-2">
          <button 
            @click="emit('edit', s)"
            :disabled="!canWrite('saveService')"
            class="h-9 px-3.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl font-bold text-xs active:bg-indigo-100 btn-press"
          >
            修改
          </button>
          <button 
            @click="emit('delete', s.id)"
            :disabled="!canWrite('deleteService')"
            class="h-9 px-3.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl font-bold text-xs active:bg-rose-100 btn-press"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  services: { type: Array, default: () => [] },
  canWrite: { type: Function, default: () => true }
});

const emit = defineEmits(['add', 'edit', 'delete']);
</script>
