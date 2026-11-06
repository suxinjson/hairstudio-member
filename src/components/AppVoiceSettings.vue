<template>
  <section v-if="!canRequest" class="bg-white rounded-3xl p-5 border border-slate-200 space-y-3">
    <p class="text-sm text-slate-600">{{ state.user && !state.syncLoginRequired
      ? '语音设置需要联网，本机账本仍可离线使用。'
      : '请登录并绑定云端门店后设置语音播报和天猫精灵。' }}</p>
    <button v-if="!state.user || state.syncLoginRequired || !state.binding" @click="emit('navigate', 'account')" class="text-indigo-700 font-bold">前往账号与同步</button>
  </section>
  <VoiceSettings v-else :key="appVoiceContext(state)" :api="cloudClient" :player="appVoicePreviewPlayer" :user="state.user" :server-url="state.serverUrl" :copy-text="copyToClipboard" class="app-voice-settings" @saved="appVoicePlayer.stop()" />
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue';
import { cloudClient, copyToClipboard } from '../cloud-device.js';
import { appVoicePlayer, appVoicePreviewPlayer, appVoiceContext } from '../app-voice.js';
import VoiceSettings from './VoiceSettings.vue';
const emit = defineEmits(['navigate']);
const state = ref(cloudClient.snapshot());
const canRequest = computed(() => Boolean(state.value.user && state.value.binding && state.value.online && !state.value.syncLoginRequired));
const unsubscribe = cloudClient.subscribe(value => { state.value = value; });
onUnmounted(unsubscribe);
</script>

<style scoped>
.app-voice-settings :deep(.p-6) { padding: 1.25rem; }
.app-voice-settings :deep(.flex.items-center.justify-between) { flex-wrap: wrap; gap: 0.5rem; }
.app-voice-settings :deep(input:not([type=checkbox]):not([type=range])),
.app-voice-settings :deep(select), .app-voice-settings :deep(textarea) { min-width: 0; font-size: 0.875rem; }
.app-voice-settings :deep(button:not([role=switch])) { min-height: 2rem; }
</style>
