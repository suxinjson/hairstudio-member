import { ref, onMounted, onUnmounted } from 'vue';

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
export function useAutoLock(onLock, timeoutMinutes = 15) {
  const timeoutMs = timeoutMinutes * 60 * 1000;
  let timer = null;

  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      onLock();
    }, timeoutMs);
  };

  const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];

  onMounted(() => {
    events.forEach(evt => window.addEventListener(evt, resetTimer, { passive: true }));
    resetTimer();
  });

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
    events.forEach(evt => window.removeEventListener(evt, resetTimer));
  });

  return { resetTimer };
}
