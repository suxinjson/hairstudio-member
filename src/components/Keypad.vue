<template>
  <div class="bg-slate-100 border-t border-slate-200/90 select-none pb-gesture-safe">
    <div class="grid grid-cols-4 gap-2.5 p-3 bg-slate-200/70">
      <!-- 1, 2, 3 -->
      <button 
        v-for="k in ['1', '2', '3']" 
        :key="k"
        @click="append(k)"
        class="h-16 bg-white text-3xl font-black rounded-2xl shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-100 border border-slate-200/60"
      >
        {{ k }}
      </button>

      <!-- 退格键 ⌫ -->
      <button 
        @click="backspace"
        class="h-16 bg-slate-300/80 text-slate-800 font-black rounded-2xl flex items-center justify-center btn-press active:bg-slate-400/80 border border-slate-300 shadow-sm"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z" />
        </svg>
      </button>

      <!-- 4, 5, 6 -->
      <button 
        v-for="k in ['4', '5', '6']" 
        :key="k"
        @click="append(k)"
        class="h-16 bg-white text-3xl font-black rounded-2xl shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-100 border border-slate-200/60"
      >
        {{ k }}
      </button>

      <!-- 清空键 C -->
      <button 
        @click="clear"
        class="h-16 bg-slate-300/80 text-slate-700 font-black text-lg rounded-2xl flex items-center justify-center btn-press active:bg-slate-400/80 border border-slate-300 shadow-sm"
      >
        清空
      </button>

      <!-- 7, 8, 9 -->
      <button 
        v-for="k in ['7', '8', '9']" 
        :key="k"
        @click="append(k)"
        class="h-16 bg-white text-3xl font-black rounded-2xl shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-100 border border-slate-200/60"
      >
        {{ k }}
      </button>

      <!-- 确认大按键 (跨两行) -->
      <button 
        @click="$emit('confirm')"
        :disabled="disabled || !isValidAmount"
        class="row-span-2 rounded-2xl font-black text-white flex flex-col items-center justify-center transition-all btn-press shadow-md tracking-wider"
        :class="disabled || !isValidAmount ? 'bg-slate-400 opacity-50 cursor-not-allowed shadow-none' : confirmColorClass"
      >
        <span class="text-xl font-black">{{ confirmText }}</span>
        <span v-if="isValidAmount" class="text-xs font-semibold opacity-90 mt-1">确认提交</span>
      </button>

      <!-- 点号 . -->
      <button 
        @click="append('.')"
        class="h-16 bg-white text-3xl font-black rounded-2xl shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-100 border border-slate-200/60"
      >
        .
      </button>

      <!-- 0 -->
      <button 
        @click="append('0')"
        class="h-16 bg-white text-3xl font-black rounded-2xl shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-100 border border-slate-200/60"
      >
        0
      </button>

      <!-- 00 -->
      <button 
        @click="append('00')"
        class="h-16 bg-white text-2xl font-black rounded-2xl shadow-sm text-slate-800 flex items-center justify-center btn-press active:bg-slate-100 border border-slate-200/60"
      >
        00
      </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { isValidMoney } from '../money.js';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  confirmText: {
    type: String,
    default: '确认扣款'
  },
  theme: {
    type: String,
    default: 'danger' // 'primary' | 'danger'
  },
  disabled: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:modelValue', 'confirm']);

const isValidAmount = computed(() => {
  return isValidMoney(props.modelValue) && Number(props.modelValue) > 0;
});

const confirmColorClass = computed(() => {
  return props.theme === 'danger' 
    ? 'bg-gradient-to-b from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 active:from-rose-700 active:to-rose-800 shadow-rose-500/30' 
    : 'bg-gradient-to-b from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 active:from-indigo-700 active:to-indigo-800 shadow-indigo-500/30';
});

function append(char) {
  let val = props.modelValue || '';
  if (char === '.') {
    if (val.includes('.')) return;
    if (val === '') val = '0';
  }
  if (val.includes('.')) {
    const parts = val.split('.');
    if (parts[1].length >= 2 && char !== '.') return;
    if (char !== '.') char = char.slice(0, 2 - parts[1].length);
  }
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
