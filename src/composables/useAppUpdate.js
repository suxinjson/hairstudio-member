import { ref, watch, onMounted, onUnmounted } from 'vue';
import { checkForUpdate } from '../cloud-device.js';

// Checks share the app's restored session. Background failures stay silent and
// can be retried on the next connection or foreground event.
export function useAppUpdate({ state, ready, isNativeApp, canPrompt, askConfirm, onUpdate,
  check = checkForUpdate, promptAutomatically = true }) {
  const availableUpdate = ref(null);
  const pendingPrompt = ref(null);
  let mounted = false, prompting = false, inFlight = null;
  let foreground = true, attempted = false, generation = 0;
  const sessionKey = () => [state.value.serverUrl, state.value.user?.storeId, state.value.user?.id].join(':');
  const eligible = () => mounted && foreground && isNativeApp && ready.value && state.value.user &&
    state.value.online && !state.value.syncLoginRequired && state.value.deviceAccess?.allowed !== false;

  async function prompt() {
    const pending = pendingPrompt.value;
    if (!promptAutomatically || !eligible() || !canPrompt?.value || prompting || !pending || pending.session !== sessionKey()) return;
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

  function startCheck(automatic) {
    const session = sessionKey(), version = generation;
    const request = { session, version, automatic, promise: null };
    inFlight = request;
    request.promise = (async () => {
      const manifest = await check();
      if (!eligible() || version !== generation || session !== sessionKey()) {
        throw new Error('账号或连接状态已变化，请重新检查更新');
      }
      availableUpdate.value = manifest;
      if (!manifest || !request.automatic) pendingPrompt.value = null;
      else if (promptAutomatically && !prompting) pendingPrompt.value = { manifest, session };
      void prompt();
      return manifest;
    })().finally(() => {
      if (inFlight === request) inFlight = null;
      if (mounted && version !== generation) void checkForUpdates();
    });
    return request.promise;
  }

  async function checkForUpdates() {
    if (!eligible() || inFlight || attempted) return;
    // Coalesce events from one opening; a real background/foreground transition
    // resets this immediately, even if the same version was just dismissed.
    attempted = true;
    try {
      await startCheck(true);
    } catch {
      // The manual update page remains available for connection diagnostics.
    }
  }

  async function checkManually() {
    if (!eligible()) throw new Error('请联网并恢复登录后检查更新');
    const session = sessionKey(), version = generation;
    attempted = true; pendingPrompt.value = null;
    if (inFlight && (inFlight.session !== session || inFlight.version !== version)) {
      await inFlight.promise.catch(() => {});
      if (!eligible() || version !== generation || session !== sessionKey()) {
        throw new Error('账号或连接状态已变化，请重新检查更新');
      }
    }
    // A manual click can reuse a current startup check without a second request
    // or an automatic prompt. Both routes publish to the same reminder state.
    if (inFlight) { inFlight.automatic = false; return inFlight.promise; }
    return startCheck(false);
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

  watch([ready, sessionKey, () => state.value.online, () => state.value.syncLoginRequired, () => state.value.deviceAccess?.allowed], (current, previous) => {
    generation++;
    // Transport failures do not revoke a version already verified for this
    // session. Clear it only on identity changes or a successful no-update check.
    if (current[1] !== previous[1]) availableUpdate.value = null;
    pendingPrompt.value = null;
    attempted = false;
    void checkForUpdates();
  });
  if (canPrompt) watch(canPrompt, () => { void prompt(); });
  const onOnline = () => { if (!inFlight) attempted = false; void checkForUpdates(); };
  onMounted(() => { mounted = true; window.addEventListener('online', onOnline); void checkForUpdates(); });
  onUnmounted(() => { mounted = false; generation++; window.removeEventListener('online', onOnline); });
  return { availableUpdate, checkManually, checkOnOpen, onBackground };
}
