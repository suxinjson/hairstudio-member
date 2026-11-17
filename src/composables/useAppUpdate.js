import { ref, watch, onMounted, onUnmounted } from 'vue';
import { checkForUpdate } from '../cloud-device.js';

// Checks share the app's restored session. Background failures stay silent and
// can be retried on the next connection or foreground event.
export function useAppUpdate({ state, ready, isNativeApp, canPrompt, askConfirm, onUpdate,
  check = checkForUpdate }) {
  const availableUpdate = ref(null);
  const pendingPrompt = ref(null);
  let mounted = false, checking = false, prompting = false;
  let foreground = true, attempted = false, generation = 0;
  const sessionKey = () => [state.value.serverUrl, state.value.user?.storeId, state.value.user?.id].join(':');
  const eligible = () => mounted && foreground && isNativeApp && ready.value && state.value.user &&
    state.value.online && !state.value.syncLoginRequired && state.value.deviceAccess?.allowed !== false;

  async function prompt() {
    const pending = pendingPrompt.value;
    if (!eligible() || !canPrompt.value || prompting || !pending || pending.session !== sessionKey()) return;
    prompting = true;
    pendingPrompt.value = null;
    try {
      const confirmed = await askConfirm({
        title: '发现新版本 ' + pending.manifest.versionName,
        message: (pending.manifest.notes ? pending.manifest.notes + '\n\n' : '') + '是否前往更新？更新无需卸载，现有账本会保留。',
        confirmText: '前往更新', cancelText: '稍后再说'
      });
      if (confirmed && eligible() && pending.session === sessionKey()) onUpdate(pending.manifest);
    } finally { prompting = false; }
  }

  async function checkForUpdates() {
    if (!eligible() || checking || attempted) return;
    const session = sessionKey(), version = generation;
    // Coalesce events from one opening; a real background/foreground transition
    // resets this immediately, even if the same version was just dismissed.
    checking = true; attempted = true;
    try {
      const manifest = await check();
      if (!eligible() || version !== generation || session !== sessionKey()) return;
      availableUpdate.value = manifest;
      if (!manifest) { pendingPrompt.value = null; return; }
      if (!prompting) pendingPrompt.value = { manifest, session };
      void prompt();
    } catch {
      // The manual update page remains available for connection diagnostics.
    } finally {
      checking = false;
      if (mounted && version !== generation) void checkForUpdates();
    }
  }

  function onBackground() {
    if (!foreground) return;
    foreground = false; attempted = false; generation++;
    pendingPrompt.value = null;
  }

  function checkOnOpen() {
    foreground = true;
    return checkForUpdates();
  }

  watch([ready, sessionKey, () => state.value.online, () => state.value.syncLoginRequired, () => state.value.deviceAccess?.allowed], () => {
    generation++;
    availableUpdate.value = null; pendingPrompt.value = null;
    attempted = false;
    void checkForUpdates();
  });
  watch(canPrompt, () => { void prompt(); });
  const onOnline = () => { if (!checking) attempted = false; void checkForUpdates(); };
  onMounted(() => { mounted = true; window.addEventListener('online', onOnline); void checkForUpdates(); });
  onUnmounted(() => { mounted = false; generation++; window.removeEventListener('online', onOnline); });
  return { availableUpdate, checkOnOpen, onBackground };
}
