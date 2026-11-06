import { cloudClient } from './cloud-device.js';
import { VoicePlayer } from './voice-player.js';

export function appVoiceContext(state = cloudClient.snapshot()) {
  return [state.serverUrl, state.binding?.storeId, state.user?.id, state.user?.role, Boolean(state.syncLoginRequired)].join(':');
}

export const appVoicePlayer = new VoicePlayer({
  api: cloudClient,
  context: () => appVoiceContext(),
  canBroadcast: () => {
    const state = cloudClient.snapshot();
    return Boolean(state.binding && state.user && state.online && !state.syncLoginRequired);
  }
});

export const appVoicePreviewPlayer = new VoicePlayer({
  api: {
    synthesizeVoice: (options, control) => options.test
      ? cloudClient.previewVoice(options, control)
      : cloudClient.synthesizeVoice(options, control)
  },
  context: () => appVoiceContext()
});
