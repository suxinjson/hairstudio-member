<template>
  <div 
    v-if="receipt" 
    class="app-modal-backdrop fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
    @click.self="emit('close')"
  >
    <div class="app-modal-surface modal-dialog bg-white rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl text-center">
      <div class="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto text-3xl font-black">
        ✓
      </div>
      <h3 class="font-black text-slate-900 text-2xl">充值入账成功</h3>
      <p class="text-sm text-slate-500 font-bold">已为会员 {{ receipt.name }} 存入额度</p>

      <div class="bg-slate-50 p-4 rounded-2xl border border-slate-200 text-left text-xs text-slate-800 leading-relaxed font-mono">
        {{ receipt.messageText }}
      </div>

      <button 
        @click="emit('copy', receipt.messageText)"
        class="w-full h-13 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-2xl text-base font-black shadow-md shadow-indigo-500/25 btn-press"
      >
        📋 一键复制致谢文案 (微信发给会员)
      </button>

      <button 
        @click="emit('close')"
        class="w-full py-2.5 text-slate-400 text-sm font-bold btn-press"
      >
        关闭
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  receipt: { type: Object, default: null }
});
const emit = defineEmits(['close', 'copy']);
</script>
