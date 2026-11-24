import { watch, onMounted, onUnmounted } from 'vue';

export function useAutoLock(session) {
  let timer = null, mounted = false;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!mounted || !session.user.value || session.isLocked.value) return;
    timer = setTimeout(checkExpiry, Math.max(0, session.idleExpiresAt.value - Date.now()));
  };
  const checkExpiry = () => {
    session.restoreSession();
    schedule();
  };
  const resetTimer = () => {
    if (session.recordActivity()) schedule();
  };
  const resume = () => {
    if (document.visibilityState !== 'hidden') checkExpiry();
  };

  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
  const stopWatch = watch([
    () => session.user.value?.storeId,
    () => session.user.value?.id,
    session.isLocked,
    session.idleExpiresAt,
  ], schedule);

  onMounted(() => {
    mounted = true;
    events.forEach(evt => window.addEventListener(evt, resetTimer, { passive: true }));
    window.addEventListener('focus', checkExpiry);
    document.addEventListener('visibilitychange', resume);
    checkExpiry();
  });

  onUnmounted(() => {
    mounted = false;
    stopWatch();
    if (timer) clearTimeout(timer);
    events.forEach(evt => window.removeEventListener(evt, resetTimer));
    window.removeEventListener('focus', checkExpiry);
    document.removeEventListener('visibilitychange', resume);
  });

  return { resetTimer };
}
