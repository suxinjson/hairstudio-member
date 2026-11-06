import { adminApi } from '../api/client.js';
import { VoicePlayer } from '../../../src/voice-player.js';

export const voicePlayer = new VoicePlayer({
  api: adminApi,
  context: () => [adminApi.generation, adminApi.user.value?.storeId, adminApi.user.value?.id, adminApi.user.value?.role, adminApi.isLocked.value].join(':'),
  canBroadcast: () => Boolean(adminApi.user.value && !adminApi.isLocked.value)
});
