<template>
  <div class="space-y-4">
    <!-- 顶部状态卡片 -->
    <section class="settings-summary bg-white border border-slate-200/90 rounded-2xl p-4 sm:p-5 shadow-xs">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2.5">
          <span class="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center shrink-0" aria-hidden="true"><Settings :size="22" /></span>
          <div>
            <h2 class="font-black text-lg text-slate-900 m-0 leading-tight">系统设置</h2>
            <p class="text-xs text-slate-500 font-medium m-0 mt-0.5">{{ storeName }}</p>
          </div>
        </div>
        <span class="settings-status inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200/60">
          <span class="w-2 h-2 rounded-full" :class="cloudOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'"></span>
          <span>{{ connectionLabel || (cloudOnline ? '云端已连接' : '本机离线') }}</span>
        </span>
      </div>
    </section>

    <!-- 分类菜单列表 -->
    <section v-for="group in groups" :key="group.title" class="settings-category">
      <h3 class="text-xs font-black text-slate-500 uppercase tracking-wider mb-2 px-1">{{ group.title }}</h3>
      <div class="settings-menu bg-white border border-slate-200/90 rounded-2xl shadow-xs overflow-hidden">
        <button
          v-for="entry in group.items"
          :key="entry.page"
          type="button"
          :aria-label="entry.title"
          :aria-describedby="'settings-description-' + entry.page"
          @click="emit('navigate', entry.page)"
          class="settings-menu-item flex items-center gap-3.5 w-full p-4 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors border-b last:border-b-0 border-slate-100 btn-press"
        >
          <span class="settings-entry-icon text-2xl w-8 text-center shrink-0" aria-hidden="true"><component v-if="icons[entry.icon]" :is="icons[entry.icon]" :size="21" /><span v-else>{{ entry.icon }}</span></span>
          <div class="settings-entry-copy flex-1 min-w-0">
            <strong class="block text-sm font-bold text-slate-800 leading-snug">{{ entry.title }}</strong>
            <small :id="'settings-description-' + entry.page" class="block text-xs text-slate-500 leading-normal mt-0.5">{{ entry.description }}</small>
          </div>
          <span class="settings-chevron text-slate-400 font-bold text-base shrink-0" aria-hidden="true">›</span>
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { Settings, Scissors, Store, Volume2, UserRound, ShieldCheck, Files, Download, CircleHelp } from 'lucide-vue-next';
const icons = { scissors: Scissors, store: Store, voice: Volume2, account: UserRound, backup: ShieldCheck, batches: Files, update: Download, help: CircleHelp };
defineProps({
  groups: { type: Array, required: true },
  storeName: { type: String, default: '我的门店' },
  connectionLabel: { type: String, default: '' },
  cloudOnline: { type: Boolean, default: false }
});

const emit = defineEmits(['navigate']);
</script>
