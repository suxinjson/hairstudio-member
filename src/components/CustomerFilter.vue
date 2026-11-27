<template>
  <div ref="root" class="customer-filter-control" @keydown.esc="escape">
    <button ref="trigger" type="button" class="customer-filter-trigger" :class="{ 'filter-active': filter !== 'all' }"
      :aria-label="`筛选会员，当前${selected.label}`" :aria-expanded="open" aria-controls="customer-filter-menu" aria-haspopup="menu"
      @click="toggle" @keydown.down.prevent="show"
      :title="`切换会员范围 · ${selected.label}`">
      <SlidersHorizontal :size="18" aria-hidden="true" /><span class="sr-only">{{ selected.label }}</span>
      <span v-if="filter !== 'all'" class="filter-active-dot" aria-hidden="true"></span>
    </button>
    <div v-if="open" id="customer-filter-menu" class="customer-filter-menu" :style="{ maxHeight: `${menuHeight}px` }" role="menu" aria-label="会员范围" @keydown="moveFocus">
      <p>查看哪些会员</p>
      <button v-for="item in MEMBER_FILTERS" :key="item.value" type="button" role="menuitemradio" :aria-checked="filter === item.value"
        @click="select(item.value)">
        <span><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span><Check v-if="filter === item.value" :size="19" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { SlidersHorizontal, Check } from 'lucide-vue-next';
import { MEMBER_FILTERS } from '../member-filters.js';

const props = defineProps({ filter: { type: String, default: 'all' }, open: Boolean });
const emit = defineEmits(['update:filter', 'update:open']);
const root = ref(null), trigger = ref(null);
const menuHeight = ref(380);
const selected = computed(() => MEMBER_FILTERS.find(item => item.value === props.filter) || MEMBER_FILTERS[0]);
function close(focus = false) { emit('update:open', false); if (focus) trigger.value?.focus({ preventScroll: true }); }
function escape(event) { if (props.open) { event.preventDefault(); event.stopPropagation(); close(true); } }
function measureMenu() {
  if (!props.open || !root.value) return;
  const viewport = window.visualViewport;
  const viewportBottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
  const navigation = document.querySelector('.app-nav')?.getBoundingClientRect();
  const bottom = navigation?.height > 0 ? Math.min(viewportBottom, navigation.top) : viewportBottom;
  menuHeight.value = Math.max(44, Math.min(380, bottom - root.value.getBoundingClientRect().bottom - 20));
}
async function show() {
  emit('update:open', true); await nextTick(); measureMenu();
  const checked = root.value?.querySelector('[aria-checked="true"]');
  checked?.focus({ preventScroll: true });
  checked?.scrollIntoView?.({ block: 'nearest' });
}
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
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', measureMenu);
  window.visualViewport?.addEventListener('resize', measureMenu);
  window.visualViewport?.addEventListener('scroll', measureMenu);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside);
  window.removeEventListener('resize', measureMenu);
  window.visualViewport?.removeEventListener('resize', measureMenu);
  window.visualViewport?.removeEventListener('scroll', measureMenu);
});
</script>
