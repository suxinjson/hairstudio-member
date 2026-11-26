<template>
  <VoiceSettings :key="[adminApi.user.value?.id, adminApi.user.value?.role].join(':')" :active="active" :api="adminApi" :player="voicePlayer" :user="adminApi.user.value" />
</template>

<script setup>
import VoiceSettings from '../../../src/components/VoiceSettings.vue';
import { adminApi } from '../api/session.js';
import { voicePlayer } from '../utils/voice-player.js';
defineProps({ active: { type: Boolean, default: true } });
</script>
