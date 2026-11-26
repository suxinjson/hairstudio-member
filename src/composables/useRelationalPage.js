import { onScopeDispose, ref, shallowRef } from 'vue';

// Bounded lists retain one page of rows and lightweight previous cursors.
export function useRelationalPage(fetchPage, { bounded = false } = {}) {
  const rows = shallowRef([]), next = shallowRef(null), cursor = shallowRef(null);
  const busy = ref(false), error = ref('');
  let sequence = 0;
  const total = ref(null), rangeLimit = ref(null), pageNumber = ref(1);
  const previous = [];
  const hasPrevious = ref(false);
  async function read(after, { reset = false } = {}) {
    const current = ++sequence;
    if (reset) {
      rows.value = []; next.value = null; cursor.value = null; total.value = null; rangeLimit.value = null;
      previous.length = 0; pageNumber.value = 1; hasPrevious.value = false;
    }
    busy.value = true; error.value = '';
    try {
      const page = await fetchPage(after);
      if (current !== sequence) return false;
      rows.value = page.items; next.value = page.nextCursor; cursor.value = after;
      if (Number.isSafeInteger(page.total)) total.value = page.total;
      rangeLimit.value = page.rangeLimit ?? null;
      hasPrevious.value = previous.length > 0;
      return true;
    } catch (cause) { if (current === sequence) error.value = cause.message; return false; }
    finally { if (current === sequence) busy.value = false; }
  }
  async function load(after = null) {
    if (bounded) return read(after, { reset: after === null });
    const current = ++sequence;
    rows.value = []; next.value = null; busy.value = true; error.value = '';
    try {
      const page = await fetchPage(after);
      if (current !== sequence) return;
      rows.value = page.items; next.value = page.nextCursor; cursor.value = after;
    } catch (cause) { if (current === sequence) error.value = cause.message; }
    finally { if (current === sequence) busy.value = false; }
  }
  async function loadMore() {
    if (busy.value || !next.value) return;
    if (bounded) {
      const prior = cursor.value;
      if (await read(next.value)) { previous.push(prior); pageNumber.value++; hasPrevious.value = true; }
      return;
    }
    const target = next.value, current = sequence;
    busy.value = true; error.value = '';
    try {
      const page = await fetchPage(target);
      if (current !== sequence) return;
      rows.value = [...rows.value, ...page.items];
      next.value = page.nextCursor;
      cursor.value = target;
    } catch (cause) { if (current === sequence) error.value = cause.message; }
    finally { if (current === sequence) busy.value = false; }
  }
  async function loadPrevious() {
    if (!bounded || busy.value || !previous.length) return;
    if (await read(previous.at(-1))) { previous.pop(); pageNumber.value--; hasPrevious.value = previous.length > 0; }
  }
  const refresh = () => bounded ? read(cursor.value) : load(cursor.value);
  onScopeDispose(() => { sequence++; });
  return { rows, next, cursor, busy, error, load, loadMore, refresh, loadPrevious, hasPrevious, pageNumber, total, rangeLimit };
}
