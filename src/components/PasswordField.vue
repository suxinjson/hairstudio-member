<template>
  <span class="password-field">
    <input ref="field" v-bind="$attrs" :value="modelValue" :type="visible ? 'text' : 'password'"
      :autocomplete="autocomplete" :placeholder="placeholder" :required="required" :disabled="disabled"
      :minlength="minlength" :maxlength="maxlength" autocapitalize="none" autocorrect="off" :spellcheck="false"
      @input="emit('update:modelValue', $event.target.value)" />
    <button type="button" class="password-toggle" :disabled="disabled" :aria-label="visible ? '隐藏密码' : '显示密码'"
      :aria-pressed="visible" @click="toggle">
      <EyeOff v-if="visible" :size="20" aria-hidden="true" />
      <Eye v-else :size="20" aria-hidden="true" />
    </button>
  </span>
</template>

<script setup>
import { ref, watch } from 'vue';
import { Eye, EyeOff } from 'lucide-vue-next';
defineOptions({ inheritAttrs: false });
const props = defineProps({
  modelValue: { type: String, default: '' },
  autocomplete: { type: String, default: 'current-password' },
  placeholder: String,
  required: Boolean,
  disabled: Boolean,
  minlength: [Number, String],
  maxlength: [Number, String]
});
const emit = defineEmits(['update:modelValue']);
const visible = ref(false), field = ref(null);
watch(() => props.modelValue, value => { if (!value) visible.value = false; });
function toggle() { visible.value = !visible.value; field.value?.focus({ preventScroll: true }); }
</script>
