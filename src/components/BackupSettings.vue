<template>
  <div class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
    <div class="flex items-center space-x-3 mb-2">
      <span class="text-3xl">🛡️</span>
      <div>
        <h2 class="font-black text-slate-900 text-lg">单机账本安全与微信备份</h2>
        <p class="text-xs text-slate-400 font-medium">数据存放在手机安全沙盒，微信备份双重保险</p>
      </div>
    </div>

    <div class="space-y-3 mt-4">
      <!-- 导出备份发到微信 -->
      <button 
        @click="emit('export-backup')"
        :disabled="isExporting"
        class="w-full h-18 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white px-4.5 rounded-2xl font-black text-sm flex items-center justify-between shadow-md shadow-emerald-600/20 btn-press"
      >
        <div class="flex items-center space-x-3">
          <span class="text-2xl">📤</span>
          <div class="text-left">
            <div class="text-base font-black">{{ storageError ? '导出账本原始数据' : '一键备份所有账本 (发送至微信)' }}</div>
            <div class="text-xs text-emerald-100 font-medium">{{ storageError ? '保留当前数据，再从有效备份恢复' : '生成全店备份文件，发给微信“文件传输助手”保存' }}</div>
          </div>
        </div>
        <span class="text-xl">›</span>
      </button>

      <!-- 导出 Excel 表格 -->
      <button 
        @click="emit('export-csv')"
        :disabled="isExporting || Boolean(storageError)"
        class="w-full h-18 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white px-4.5 rounded-2xl font-black text-sm flex items-center justify-between shadow-md shadow-blue-500/20 btn-press"
      >
        <div class="flex items-center space-x-3">
          <span class="text-2xl">📊</span>
          <div class="text-left">
            <div class="text-base font-black">导出 Excel 对账明细表 (.csv)</div>
            <div class="text-xs text-blue-100 font-medium">手机 WPS 或电脑直接打开核算对账</div>
          </div>
        </div>
        <span class="text-xl">›</span>
      </button>

      <!-- 恢复备份 -->
      <div class="pt-2">
        <label class="w-full h-18 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-800 px-4.5 rounded-2xl font-black text-sm flex items-center justify-between border-2 border-slate-200 cursor-pointer">
          <div class="flex items-center space-x-3">
            <span class="text-2xl">📥</span>
            <div class="text-left">
              <div class="text-base font-black text-slate-900">从微信备份文件恢复数据</div>
              <div class="text-xs text-slate-500 font-medium">换新手机或误删时，选中备份文件一秒瞬间还原</div>
            </div>
          </div>
          <span class="text-indigo-600 font-extrabold text-xs bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded-xl">选择文件</span>
          <input type="file" accept=".json" @change="emit('import-backup', $event)" class="hidden" />
        </label>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  isExporting: Boolean,
  storageError: { type: String, default: '' }
});
const emit = defineEmits(['export-backup', 'export-csv', 'import-backup']);
</script>
