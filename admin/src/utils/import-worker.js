import { parseImportBuffer } from './import-parser.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ rows: parseImportBuffer(data.buffer, data.isCsv) }); }
  catch (error) { self.postMessage({ error: error.message || '文件解析失败' }); }
};
