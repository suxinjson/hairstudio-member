<template>
  <div ref="root" class="customer-filter-control" @keydown.esc="escape">
    <button ref="trigger" type="button" class="customer-filter-trigger" :class="{ 'filter-active': filter !== 'all' }"
      :aria-label="`筛选会员，当前${selected.label}`" :aria-expanded="open" aria-controls="customer-filter-menu" aria-haspopup="menu"
      @click="toggle" @keydown.down.prevent="show">
      <SlidersHorizontal :size="18" aria-hidden="true" /><span>筛选</span><ChevronDown :size="13" :class="{ 'filter-chevron-open': open }" aria-hidden="true" />
    </button>
    <div v-if="open" id="customer-filter-menu" class="customer-filter-menu" role="menu" aria-label="会员范围" @keydown="moveFocus">
      <p>查看哪些会员</p>
      <button v-for="item in CUSTOMER_FILTERS" :key="item.value" type="button" role="menuitemradio" :aria-checked="filter === item.value"
        @click="select(item.value)">
        <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><Check v-if="filter === item.value" :size="19" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { SlidersHorizontal, ChevronDown, Check } from 'lucide-vue-next';

const CUSTOMER_FILTERS = [
  { value: 'all', label: '全部会员', description: '查看完整会员名单' },
  { value: 'recent', label: '最近来店', description: '按消费时间，显示最近会员' },
  { value: 'low', label: '低余额', description: '可用余额 0–50 元' },
  { value: 'debt', label: '欠款会员', description: '查看待还款会员' }
];

const props = defineProps({ filter: { type: String, default: 'all' }, open: Boolean });
const emit = defineEmits(['update:filter', 'update:open']);
const root = ref(null), trigger = ref(null);
const selected = computed(() => CUSTOMER_FILTERS.find(item => item.value === props.filter) || CUSTOMER_FILTERS[0]);
function close(focus = false) { emit('update:open', false); if (focus) trigger.value?.focus(); }
function escape(event) { if (props.open) { event.preventDefault(); event.stopPropagation(); close(true); } }
async function show() { emit('update:open', true); await nextTick(); root.value?.querySelector('[aria-checked="true"]')?.focus(); }
function toggle() { if (props.open) close(); else void show(); }
function select(value) { emit('update:filter', value); close(true); }
function outside(event) { if (!root.value?.contains(event.target)) close(); }
function moveFocus(event) {
  const buttons = [...root.value.querySelectorAll('[role="menuitemradio"]')];
  const index = buttons.indexOf(document.activeElement);
  let next;
  if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % buttons.length;
  if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index + buttons.length - 1) % buttons.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = buttons.length - 1;
  if (next !== undefined) { event.preventDefault(); buttons[next].focus(); }
  if (event.key === 'Tab') close();
}
onMounted(() => document.addEventListener('pointerdown', outside));
onUnmounted(() => document.removeEventListener('pointerdown', outside));
</script>
