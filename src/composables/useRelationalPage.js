import { onScopeDispose, ref, shallowRef } from 'vue';

// Only the visible page and its two navigation cursor values are retained.
export function useRelationalPage(fetchPage) {
  const rows = shallowRef([]), next = shallowRef(null), cursor = shallowRef(null);
  const busy = ref(false), error = ref('');
  let sequence = 0;
  async function load(after = null) {
    const current = ++sequence;
    rows.value = []; next.value = null; busy.value = true; error.value = '';
    try {
      const page = await fetchPage(after);
      if (current !== sequence) return;
      rows.value = page.items; next.value = page.nextCursor; cursor.value = after;
    } catch (cause) { if (current === sequence) error.value = cause.message; }
    finally { if (current === sequence) busy.value = false; }
  }
  onScopeDispose(() => { sequence++; });
  return { rows, next, cursor, busy, error, load };
}
