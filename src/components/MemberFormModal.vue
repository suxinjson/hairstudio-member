<template>
  <div 
    v-if="modelValue" 
    class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
    @click.self="emit('update:modelValue', false)"
  >
    <div class="modal-dialog bg-white rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
      <div class="flex items-center justify-between border-b pb-3">
        <h3 class="font-black text-xl text-slate-900">
          {{ editingId ? '修改会员档案' : '登记新会员档案' }}
        </h3>
        <button @click="emit('update:modelValue', false)" class="text-slate-400 text-xl font-bold btn-press">✕</button>
      </div>

      <p v-if="editingId" class="text-xs text-slate-500 break-all">会员单号：{{ editingId }}</p>
      <div class="space-y-4 text-sm">
        <div>
          <label class="font-black text-slate-800 block mb-1.5">会员姓名 <span class="text-rose-500">*</span></label>
          <input 
            v-model="form.name" 
            type="text" 
            placeholder="如：张姐 / 8号熟客" 
            class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
          />
        </div>

        <div>
          <label class="font-black text-slate-800 block mb-1.5">手机号码 <span class="text-rose-500">*</span></label>
          <input 
            v-model="form.phone" 
            type="tel" 
            placeholder="报手机尾号查找的唯一依据" 
            class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-mono font-black text-base"
          />
        </div>

        <div v-if="!editingId">
          <label class="font-black text-slate-800 block mb-1.5">开卡充值金额 (元，无充值填0)</label>
          <input 
            v-model.number="form.initialBalance" 
            type="number" 
            step="0.01" 
            placeholder="0.00" 
            class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
          />
        </div>

        <div>
          <label class="font-black text-slate-800 block mb-1.5">发型与习惯偏好备注</label>
          <textarea 
            v-model="form.notes" 
            rows="2" 
            placeholder="如：短发圆寸、染发板栗色、不喜欢推子太贴皮等" 
            class="w-full p-3.5 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 resize-none font-bold text-sm"
          ></textarea>
        </div>
      </div>

      <div class="flex space-x-3 pt-2">
        <button 
          @click="emit('update:modelValue', false)"
          class="flex-1 h-13 rounded-2xl border-2 border-slate-300 text-sm font-black text-slate-600 active:bg-slate-100 btn-press"
        >
          取消
        </button>
        <button 
          @click="emit('save')"
          :disabled="isSaving || !canWrite || !form.name.trim() || !form.phone.trim()"
          class="flex-1 h-13 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-sm font-black text-white shadow-md shadow-indigo-500/20 btn-press"
        >
          保存档案
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  modelValue: Boolean,
  editingId: { type: String, default: '' },
  form: { type: Object, required: true },
  isSaving: Boolean,
  canWrite: { type: Boolean, default: true }
});
const emit = defineEmits(['update:modelValue', 'save']);
</script>
