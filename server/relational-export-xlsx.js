import { parentPort, workerData } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import { LEDGER_EXPORT, LEDGER_SHEET, relationalExportBook } from '../src/relational-export-sheet.js';

const book = relationalExportBook(XLSX, { name: LEDGER_SHEET, rows: workerData });
const file = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
if (file.length > LEDGER_EXPORT.bytes) parentPort.postMessage({ tooLarge: true });
else {
  const bytes = new Uint8Array(file); parentPort.postMessage({ bytes }, [bytes.buffer]);
}
