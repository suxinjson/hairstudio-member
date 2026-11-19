<template>
  <aside v-if="items.length" class="notice-ticker" aria-label="待看提醒摘要" @mouseenter="paused = true" @mouseleave="paused = false" @focusin="paused = true" @focusout="paused = false">
    <button type="button" class="notice-preview" @click="$emit('open')" :aria-label="`查看提醒：${current?.title || ''}`">
      <Info :size="18" aria-hidden="true" />
      <span class="notice-ticker-copy">
        <span :key="current?.id">{{ current?.title }}</span>
      </span>
      <ChevronRight :size="16" aria-hidden="true" />
    </button>
    <button v-if="items.length > 1" type="button" class="notice-ticker-pause" :aria-label="stopped ? '继续轮播提醒' : '暂停轮播提醒'" @click="stopped = !stopped">
      <Play v-if="stopped" :size="12" aria-hidden="true" /><Pause v-else :size="12" aria-hidden="true" />
    </button>
  </aside>
</template>
<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { Info, ChevronRight, Play, Pause } from 'lucide-vue-next';
const props = defineProps({ items: { type: Array, default: () => [] } });
defineEmits(['open']);
const index = ref(0), paused = ref(false), stopped = ref(false);
const current = computed(() => props.items[index.value % (props.items.length || 1)]);
watch(() => props.items.map(item => item.id).join(','), () => { index.value = 0; });
let timer, motion;
onMounted(() => {
  motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  timer = setInterval(() => {
    if (props.items.length > 1 && !paused.value && !stopped.value && !motion?.matches && document.visibilityState !== 'hidden') index.value++;
  }, 6000);
});
onUnmounted(() => clearInterval(timer));
</script>
