<template>
  <div 
    v-if="modelValue" 
    class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
    @click.self="emit('update:modelValue', false)"
  >
    <div class="modal-dialog bg-white rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
      <div class="flex items-center justify-between border-b pb-3">
        <h3 class="font-black text-xl text-slate-900">
          {{ form.id ? '修改服务项目' : '新增服务项目' }}
        </h3>
        <button @click="emit('update:modelValue', false)" class="text-slate-400 text-xl font-bold btn-press">✕</button>
      </div>

      <div class="space-y-4 text-sm">
        <div>
          <label class="font-black text-slate-800 block mb-1.5">服务项目名称 <span class="text-rose-500">*</span></label>
          <input 
            v-model="form.name" 
            type="text" 
            placeholder="如：商品购买 / 服务项目"
            class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
          />
        </div>

        <div>
          <label class="font-black text-slate-800 block mb-1.5">默认价格 (元) <span class="text-rose-500">*</span></label>
          <input 
            v-model.number="form.price" 
            type="number" 
            step="0.01" 
            placeholder="0.00" 
            class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
          />
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
          :disabled="isSaving || !canWrite || !form.name || form.price === ''"
          class="flex-1 h-13 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-sm font-black text-white shadow-md shadow-indigo-500/20 btn-press"
        >
          保存项目
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  modelValue: Boolean,
  form: { type: Object, required: true },
  isSaving: Boolean,
  canWrite: { type: Boolean, default: true }
});
const emit = defineEmits(['update:modelValue', 'save']);
</script>
