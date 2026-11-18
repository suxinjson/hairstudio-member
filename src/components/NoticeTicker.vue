<template>
  <div class="notice-ticker" @mouseenter="paused = true" @mouseleave="paused = false" @focusin="paused = true" @focusout="paused = false">
    <button type="button" class="notice-entry" :class="{ 'has-notices': items.length }"
      :aria-label="items.length ? `提醒中心，${items.length} 条待看提醒` : '提醒中心，暂无待看提醒'" @click="$emit('open')">
      <Bell :size="16" aria-hidden="true" />
      <span>提醒</span><span v-if="items.length" class="notice-count">{{ items.length > 99 ? '99+' : items.length }}</span>
      <span class="notice-ticker-copy" aria-hidden="true">
        <span :key="current?.id || 'empty'">{{ current?.title || '暂无待看提醒' }}</span>
      </span>
      <ChevronRight :size="13" aria-hidden="true" />
    </button>
    <button v-if="items.length > 1" type="button" class="notice-ticker-pause" :aria-label="stopped ? '继续轮播提醒' : '暂停轮播提醒'" @click="stopped = !stopped">
      <Play v-if="stopped" :size="12" aria-hidden="true" /><Pause v-else :size="12" aria-hidden="true" />
    </button>
  </div>
</template>
<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { Bell, ChevronRight, Play, Pause } from 'lucide-vue-next';
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
