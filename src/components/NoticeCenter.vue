<template>
  <section class="notice-center" aria-labelledby="notice-center-title">
    <button type="button" class="notice-back" @click="$emit('back')"><ArrowLeft :size="18" aria-hidden="true" />返回</button>
    <div class="notice-center-heading">
      <div><h2 id="notice-center-title" tabindex="-1" ref="heading">提醒中心</h2><p>{{ pendingCount ? `${pendingCount} 条待看提醒，集中在这里处理` : '暂无待看提醒，安心处理店务' }}</p></div>
      <span class="notice-auto-label">自动更新</span>
    </div>
    <div class="notice-view-tabs" aria-label="提醒状态">
      <button v-for="tab in tabs" :key="tab.value" type="button" :aria-pressed="view === tab.value" @click="view = tab.value">{{ tab.label }}<span>{{ tab.count }}</span></button>
    </div>
    <div v-if="!visible.length" class="notice-empty"><CheckCheck :size="36" aria-hidden="true" /><h3>{{ view === 'handled' ? '还没有已知晓的提醒' : '这里都处理好了' }}</h3><p>会员欠款、同步与账本提醒会在这里自动汇总。</p></div>
    <article v-for="item in visible" :key="item.id" class="notice-card" :class="['notice-type-' + item.type, { 'notice-handled': item.acknowledged }]">
      <div class="notice-card-top"><span class="notice-type-label"><component :is="item.type === 'warning' ? CircleAlert : item.type === 'reminder' ? Bell : Megaphone" :size="15" aria-hidden="true" />{{ noticeTypeLabel(item.type) }}</span><span>自动提醒</span><span v-if="item.acknowledged" class="notice-read-label">已知晓</span></div>
      <h3>{{ item.title }}</h3><p class="notice-body">{{ item.body }}</p>
      <p v-if="item.required" class="notice-card-hint">处理完成后自动移除</p>
      <div class="notice-card-actions">
        <button v-if="item.action" type="button" class="notice-action-link" @click="$emit('navigate', item.action)">{{ item.actionLabel }}<ChevronRight :size="16" aria-hidden="true" /></button>
        <button v-if="item.buttonLabel && !item.acknowledged" type="button" class="notice-acknowledge" @click="$emit('act', item, 'acknowledge')">{{ item.buttonLabel }}</button>
        <button v-if="item.allowDelete" type="button" class="notice-delete" :aria-label="`删除提醒：${item.title}`" @click="$emit('act', item, 'delete')"><Trash2 :size="16" aria-hidden="true" /><span>删除</span></button>
      </div>
    </article>
    <p v-if="items.length" class="notice-footnote">知晓后本机顶部不再提醒，可在“已知晓”中回看。情况有新变化时会再次提醒。</p>
  </section>
</template>
<script setup>
import { computed, ref, onMounted } from 'vue';
import { ArrowLeft, CheckCheck, Bell, CircleAlert, Megaphone, ChevronRight, Trash2 } from 'lucide-vue-next';
import { noticeTypeLabel } from '../notices.js';
const props = defineProps({ items: { type: Array, default: () => [] } });
defineEmits(['back', 'navigate', 'act']);
const view = ref('pending'), heading = ref(null);
const pendingCount = computed(() => props.items.filter(item => !item.acknowledged).length);
const tabs = computed(() => [{ value: 'pending', label: '待看', count: pendingCount.value }, { value: 'handled', label: '已知晓', count: props.items.length - pendingCount.value }, { value: 'all', label: '全部', count: props.items.length }]);
const visible = computed(() => props.items.filter(item => view.value === 'all' || Boolean(item.acknowledged) === (view.value === 'handled')));
onMounted(() => heading.value?.focus({ preventScroll: true }));
</script>
