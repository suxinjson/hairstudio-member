import { ref, computed } from 'vue';

export function useFormatters() {
  const currentDate = ref(new Date());

  const compactDateText = computed(() => {
    return `${currentDate.value.getMonth() + 1}/${String(currentDate.value.getDate()).padStart(2, '0')}`;
  });

  const currentDateText = computed(() => {
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const m = currentDate.value.getMonth() + 1;
    const d = currentDate.value.getDate();
    const w = weekDays[currentDate.value.getDay()];
    return `${m}月${d}日 ${w}`;
  });

  function formatCent(cent) {
    if (cent === undefined || cent === null || isNaN(cent)) return '0.00';
    return (cent / 100).toFixed(2);
  }

  function formatPhoneSpaced(phone) {
    if (!phone) return '';
    const clean = String(phone).replace(/\s+/g, '');
    if (clean.length === 11) return `${clean.slice(0, 3)} ${clean.slice(3, 7)} ${clean.slice(7)}`;
    return clean;
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${m}月${day}日 ${h}:${min}`;
    } catch {
      return isoStr;
    }
  }

  function getTypeText(type) {
    const map = { RECHARGE: '充值', CONSUME: '消费', REFUND: '冲正撤单' };
    return map[type] || type;
  }

  function getBadgeClass(type) {
    const map = {
      RECHARGE: 'bg-emerald-100 text-emerald-800',
      CONSUME: 'bg-rose-100 text-rose-800',
      REFUND: 'bg-amber-100 text-amber-900 font-bold'
    };
    return map[type] || 'bg-slate-100 text-slate-800';
  }

  return {
    currentDate,
    compactDateText,
    currentDateText,
    formatCent,
    formatPhoneSpaced,
    formatTime,
    getTypeText,
    getBadgeClass
  };
}
