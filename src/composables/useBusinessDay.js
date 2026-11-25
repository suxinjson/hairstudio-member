import { onMounted, onScopeDispose, ref } from 'vue';
import { BUSINESS_OFFSET, todayBusiness } from '../relational-presentation.js';

export function useBusinessDay() {
  const day = ref(todayBusiness());
  let timer;
  function refresh() {
    day.value = todayBusiness();
    clearTimeout(timer);
    const now = Date.now();
    const next = (Math.floor((now + BUSINESS_OFFSET * 60000) / 86400000) + 1) * 86400000 - BUSINESS_OFFSET * 60000;
    timer = setTimeout(refresh, Math.max(1, next - now + 50));
  }
  function foreground() { if (document.visibilityState !== 'hidden') refresh(); }
  onMounted(() => {
    refresh();
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
  });
  onScopeDispose(() => {
    clearTimeout(timer);
    window.removeEventListener('focus', foreground);
    document.removeEventListener('visibilitychange', foreground);
  });
  return day;
}
