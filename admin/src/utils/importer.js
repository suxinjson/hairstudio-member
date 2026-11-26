import { IMPORT_LIMITS, assertImportRowsBudget } from './import-budget.js';

export async function parseUploadedFile(file, { signal } = {}) {
  // 1. 安全限制检查：最大 10MB
  const MAX_FILE_SIZE = IMPORT_LIMITS.bytes;
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('导入文件过大，最大支持 10MB');
  }

  const name = file.name.toLowerCase();
  const isExcel = name.endsWith('.xlsx') || name.endsWith('.xls');
  const isCsv = name.endsWith('.csv');

  if (!isExcel && !isCsv) {
    throw new Error('仅支持上传 .xlsx、.xls 或 .csv 格式的文件');
  }

  // 2. 读取二进制数据
  signal?.throwIfAborted();
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (buffer.byteLength > MAX_FILE_SIZE) throw new Error('导入文件过大，最大支持 10MB');
  const rawRows = await readRows(buffer, isCsv, signal);

  return rawRows;
}

function readRows(buffer, isCsv, signal) {
  // The Node test/runtime has no browser Worker. Both paths enforce identical budgets.
  if (typeof Worker === 'undefined') {
    if (globalThis.process?.versions?.node) return import('./import-parser.js').then(({ parseImportBuffer }) => parseImportBuffer(buffer, isCsv));
    throw new Error('当前浏览器无法安全解析文件，请使用新版 Chrome、Edge、Firefox 或 Safari');
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./import-worker.js', import.meta.url), { type: 'module' });
    let timer, settled = false;
    const finish = (error, rows) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(rows);
    };
    const abort = () => finish(signal.reason || new DOMException('已取消文件解析', 'AbortError'));
    worker.onmessage = ({ data }) => {
      try {
        if (!data || data.error) throw new Error(data?.error || '文件解析返回格式无效');
        finish(null, assertImportRowsBudget(data.rows));
      } catch (error) { finish(error); }
    };
    worker.onerror = () => finish(new Error('文件解析失败，请检查格式后重试'));
    timer = setTimeout(() => finish(new Error('文件解析超时，请缩小文件或工作表范围后重试')), 10000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try { worker.postMessage({ buffer, isCsv }, [buffer]); }
    catch (error) { finish(error); }
  });
}
