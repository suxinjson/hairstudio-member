<template>
  <div class="space-y-4">
    <template v-if="page === 'overview'">
      <section class="settings-summary bg-white border border-slate-200 rounded-2xl p-5">
        <div class="flex items-center justify-between gap-3">
          <h2 class="font-black text-xl">设置</h2>
          <span class="settings-status">{{ cloudState.webOnly ? (cloudState.online ? '服务器已连接' : '服务器待确认') : cloudState.user ? (cloudState.online && !cloudState.syncLoginRequired ? '云端已登录' : '离线可用') : '本机模式' }}</span>
        </div>
        <p class="text-sm text-slate-500 mt-2">{{ cloudState.webOnly ? (cloudState.user?.displayName || '') + ' · 直接使用服务器账本' : cloudState.user ? cloudState.user.displayName + ' · ' + (cloudState.binding ? '账本已保存在本机，联网自动同步' : '可继续使用本机账本') : '无需登录也能使用本机账本' }}</p>
        <p v-if="!cloudState.webOnly && cloudState.binding" class="text-sm text-slate-600 mt-2">待同步 {{ cloudState.outbox.length }} 笔<span v-if="cloudState.syncLoginRequired"> · 同步前需登录原账号</span></p>
      </section>
      <section v-for="group in groups" :key="group.title" class="settings-category">
        <h3 class="text-sm font-bold text-slate-500 mb-2">{{ group.title }}</h3>
        <div class="settings-menu bg-white border border-slate-200 rounded-2xl">
          <button v-for="entry in group.items" :key="entry.page" @click="emit('navigate', entry.page)" class="settings-menu-item">
            <span class="settings-entry-icon" aria-hidden="true">{{ entry.icon }}</span>
            <span class="settings-entry-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span>
            <span class="settings-chevron" aria-hidden="true">›</span>
          </button>
        </div>
      </section>
    </template>
    <section v-else-if="page === 'backup'" class="settings-menu bg-white border border-slate-200 rounded-2xl">
      <button v-for="entry in backupEntries" :key="entry.page" @click="emit('navigate-page', entry.page)" class="settings-menu-item">
        <span class="settings-entry-icon" aria-hidden="true">{{ entry.icon }}</span>
        <span class="settings-entry-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span>
        <span class="settings-chevron" aria-hidden="true">›</span>
      </button>
    </section>
  </div>
</template>

<script setup>
defineProps({
  page: { type: String, default: 'overview' },
  cloudState: { type: Object, required: true },
  groups: { type: Array, required: true },
  backupEntries: { type: Array, required: true }
});

const emit = defineEmits(['navigate', 'navigate-page']);
</script>
