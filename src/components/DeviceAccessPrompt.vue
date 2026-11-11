<template>
  <div class="app-modal-backdrop fixed inset-0 z-[80] bg-slate-950/70 flex items-center justify-center p-5" role="dialog" aria-modal="true" aria-labelledby="device-prompt-title">
    <div class="app-modal-surface bg-white rounded-3xl p-6 w-full max-w-sm space-y-5 shadow-2xl">
      <h2 id="device-prompt-title" class="text-2xl font-black">{{ access?.allowed === false ? '请先确认使用权限' : '请联网登录' }}</h2>
      <p class="text-lg leading-relaxed">{{ access?.allowed === false ? access.reason : '当前无法连接云端，请联网登录。您的账本和未同步记录已保存在手机里。' }}</p>
      <p v-if="access?.allowed && access.offlineUntil" class="text-base text-slate-600">可暂时使用至 {{ new Date(access.offlineUntil).toLocaleString('zh-CN') }}。</p>
      <button autofocus @click="$emit('login')" class="w-full min-h-14 rounded-2xl bg-indigo-700 text-white text-xl font-bold p-4">去登录</button>
      <button v-if="access?.allowed !== false" @click="$emit('later')" class="w-full min-h-14 rounded-2xl border-2 text-xl font-bold p-4">暂不登录</button>
    </div>
  </div>
</template>

<script setup>
defineProps({ access: Object });
defineEmits(['login', 'later']);
</script>
