<template>
  <div class="bg-white border-t border-slate-200 select-none pb-safe">
    <div class="grid grid-cols-4 gap-1 p-2 bg-slate-100">
      <button 
        v-for="k in ['1', '2', '3']" 
        :key="k"
        @click="append(k)"
        class="h-14 bg-white text-xl font-semibold rounded-lg shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-200"
      >
        {{ k }}
      </button>
      <button 
        @click="backspace"
        class="h-14 bg-slate-200 text-slate-700 font-medium rounded-lg flex items-center justify-center btn-press active:bg-slate-300"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z" />
        </svg>
      </button>

      <button 
        v-for="k in ['4', '5', '6']" 
        :key="k"
        @click="append(k)"
        class="h-14 bg-white text-xl font-semibold rounded-lg shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-200"
      >
        {{ k }}
      </button>
      <button 
        @click="clear"
        class="h-14 bg-slate-200 text-slate-700 font-medium rounded-lg flex items-center justify-center text-sm btn-press active:bg-slate-300"
      >
        清空
      </button>

      <button 
        v-for="k in ['7', '8', '9']" 
        :key="k"
        @click="append(k)"
        class="h-14 bg-white text-xl font-semibold rounded-lg shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-200"
      >
        {{ k }}
      </button>
      <button 
        @click="$emit('confirm')"
        :disabled="disabled || !isValidAmount"
        class="row-span-2 rounded-lg font-bold text-white flex flex-col items-center justify-center transition-all btn-press shadow-md"
        :class="disabled || !isValidAmount ? 'bg-slate-400 opacity-60 cursor-not-allowed' : confirmColorClass"
      >
        <span class="text-base">{{ confirmText }}</span>
      </button>

      <button 
        @click="append('.')"
        class="h-14 bg-white text-2xl font-bold rounded-lg shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-200"
      >
        .
      </button>
      <button 
        @click="append('0')"
        class="h-14 bg-white text-xl font-semibold rounded-lg shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-200"
      >
        0
      </button>
      <button 
        @click="append('00')"
        class="h-14 bg-white text-lg font-semibold rounded-lg shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-200"
      >
        00
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  confirmText: {
    type: String,
    default: '确认'
  },
  theme: {
    type: String,
    default: 'primary' // 'primary' | 'danger'
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:modelValue', 'confirm']);

const isValidAmount = computed(() => {
  const n = parseFloat(props.modelValue);
  return !isNaN(n) && n > 0;
});

const confirmColorClass = computed(() => {
  return props.theme === 'danger' ? 'bg-red-600 active:bg-red-700' : 'bg-blue-600 active:bg-blue-700';
});

function append(char) {
  let val = props.modelValue || '';
  if (char === '.') {
    if (val.includes('.')) return;
    if (val === '') val = '0';
  }
  // 限制小数位最多两位
  if (val.includes('.')) {
    const parts = val.split('.');
    if (parts[1].length >= 2 && char !== '.') return;
  }
  // 限制长度
  if (val.length > 8) return;
  
  if (val === '0' && char !== '.') {
    val = char;
  } else {
    val += char;
  }
  emit('update:modelValue', val);
}

function backspace() {
  let val = props.modelValue || '';
  if (val.length > 0) {
    val = val.slice(0, -1);
    emit('update:modelValue', val);
  }
}

function clear() {
  emit('update:modelValue', '');
}
</script>
