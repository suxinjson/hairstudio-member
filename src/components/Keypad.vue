<template>
  <div class="keypad select-none">
    <div class="keypad-grid grid grid-cols-4">
      <!-- 1, 2, 3 -->
      <button 
        v-for="k in ['1', '2', '3']" 
        :key="k"
        type="button"
        @click="append(k)"
        class="keypad-key flex items-center justify-center btn-press"
      >
        {{ k }}
      </button>

      <!-- 退格键 ⌫ -->
      <button 
        type="button"
        @click="backspace"
        aria-label="删除最后一位金额"
        class="keypad-key keypad-function flex items-center justify-center btn-press"
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 12l6.414 6.414a2 2 0 001.414.586H19a2 2 0 002-2V7a2 2 0 00-2-2h-8.172a2 2 0 00-1.414.586L3 12z" />
        </svg>
      </button>

      <!-- 4, 5, 6 -->
      <button 
        v-for="k in ['4', '5', '6']" 
        :key="k"
        type="button"
        @click="append(k)"
        class="keypad-key flex items-center justify-center btn-press"
      >
        {{ k }}
      </button>

      <!-- 清空键 C -->
      <button 
        type="button"
        @click="clear"
        aria-label="清空扣款金额"
        class="keypad-key keypad-function flex items-center justify-center btn-press"
      >
        清空
      </button>

      <!-- 7, 8, 9 -->
      <button 
        v-for="k in ['7', '8', '9']" 
        :key="k"
        type="button"
        @click="append(k)"
        class="keypad-key flex items-center justify-center btn-press"
      >
        {{ k }}
      </button>

      <!-- 确认大按键 (跨两行) -->
      <button 
        type="button"
        @click="handleConfirm"
        :disabled="disabled || !isValidAmount"
        class="keypad-confirm row-span-2 rounded-2xl font-black text-white flex flex-col items-center justify-center transition-all btn-press shadow-md tracking-wider"
        :class="disabled || !isValidAmount ? 'bg-slate-400 opacity-50 cursor-not-allowed shadow-none' : confirmColorClass"
      >
        <span class="text-xl font-black">{{ confirmText }}</span>
        <span v-if="isValidAmount" class="text-xs font-semibold opacity-90 mt-1">确认提交</span>
      </button>

      <!-- 点号 . -->
      <button 
        type="button"
        @click="append('.')"
        class="keypad-key flex items-center justify-center btn-press"
      >
        .
      </button>

      <!-- 0 -->
      <button 
        type="button"
        @click="append('0')"
        class="keypad-key flex items-center justify-center btn-press"
      >
        0
      </button>

      <!-- 00 -->
      <button 
        type="button"
        @click="append('00')"
        class="keypad-key flex items-center justify-center btn-press"
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

function triggerHaptic() {
  try {
    if (typeof navigator !== 'undefined' && navigator?.vibrate) {
      navigator.vibrate(10);
    }
  } catch (_) {}
}

function append(char) {
  triggerHaptic();
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
  triggerHaptic();
  let val = props.modelValue || '';
  if (val.length > 0) {
    val = val.slice(0, -1);
    emit('update:modelValue', val);
  }
}

function clear() {
  triggerHaptic();
  emit('update:modelValue', '');
}

function handleConfirm() {
  triggerHaptic();
  emit('confirm');
}
</script>
