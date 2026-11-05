import { watch, onMounted, onUnmounted } from 'vue';

/**
 * 手机号脱敏显示 (保护会员隐私安全)
 */
export function maskPhone(phone, unmasked = false) {
  if (!phone) return '—';
  const clean = String(phone).replace(/\s+/g, '');
  if (unmasked) {
    if (clean.length === 11) return `${clean.slice(0, 3)} ${clean.slice(3, 7)} ${clean.slice(7)}`;
    return clean;
  }
  if (clean.length === 11) {
    return `${clean.slice(0, 3)} **** ${clean.slice(7)}`;
  }
  return clean.length > 4 ? `${clean.slice(0, 3)}****${clean.slice(-2)}` : '****';
}

/**
 * 金额分转元格式化
 */
export function formatYuan(cents) {
  if (cents === undefined || cents === null || isNaN(cents)) return '0.00';
  return (cents / 100).toFixed(2);
}

/**
 * 空闲超时自动锁屏组合式函数 (默认 15 分钟)
 */
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
    session.recordActivity();
    schedule();
  };
  const resume = () => {
    if (document.visibilityState !== 'hidden') checkExpiry();
  };

  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
  const stopWatch = watch([session.user, session.isLocked, session.idleExpiresAt], schedule);

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
