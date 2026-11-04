<template>
  <div class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
    <div class="flex items-center justify-between pb-3.5 border-b border-slate-100">
      <div class="flex items-center space-x-2.5">
        <span class="text-2xl">📑</span>
        <div>
          <h3 class="font-black text-slate-900 text-base">App检测到的本地备份 (共 {{ snapshots.length }} 份)</h3>
          <p class="text-xs text-slate-400 font-medium">手机专属沙盒内安全快照，点击可直接恢复</p>
        </div>
      </div>
      <button 
        @click="emit('create')"
        class="h-9 px-3 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-bold rounded-xl btn-press"
      >
        + 立即归档
      </button>
    </div>

    <div v-if="snapshots.length === 0" class="py-8 text-center text-xs text-slate-400 font-bold">
      暂无历史快照，点击上方「一键备份所有账本」可自动生成并归档
    </div>
    <div v-else class="space-y-3 mt-3.5">
      <div 
        v-for="s in snapshots" 
        :key="s.id" 
        class="p-4 bg-slate-50/90 rounded-2xl border border-slate-200/90 text-xs space-y-2.5"
      >
        <div class="flex items-center justify-between">
          <span class="font-black text-slate-900 text-sm truncate max-w-[210px]">{{ s.fileName }}</span>
          <span class="text-[11px] bg-indigo-100 text-indigo-900 font-bold px-2 py-0.5 rounded-lg">{{ s.tag }}</span>
        </div>
        <div class="flex items-center justify-between text-slate-600 font-medium">
          <span>{{ formatTime(s.createdAt) }}</span>
          <span>包含 {{ s.memberCount }} 客户 · {{ s.ledgerCount }} 笔流水 · 净余额 ¥{{ formatCent(s.totalBalance) }}</span>
        </div>
        <div class="flex space-x-2 pt-2 border-t border-slate-200/70">
          <button 
            @click="emit('restore', s, 'merge')" 
            class="flex-1 h-9 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold rounded-xl btn-press shadow-xs"
          >
            🛡️ 智能合并恢复 (推荐)
          </button>
          <button 
            @click="emit('share', s)" 
            :disabled="isExporting"
            class="h-9 px-3.5 bg-slate-200 hover:bg-slate-300 active:bg-slate-400 text-slate-800 font-bold rounded-xl btn-press"
          >
            📤 分享
          </button>
          <button 
            @click="emit('delete', s.id)" 
            class="h-9 px-3 text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 font-bold rounded-xl btn-press"
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
  snapshots: { type: Array, default: () => [] },
  isExporting: Boolean,
  formatTime: { type: Function, required: true },
  formatCent: { type: Function, required: true }
});
const emit = defineEmits(['create', 'restore', 'share', 'delete']);
</script>
