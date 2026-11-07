import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, constants } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import * as XLSX from 'xlsx';
import { checkZipBudget } from '../admin/src/utils/zip-budget.js';
import { parseImportBuffer } from '../admin/src/utils/import-parser.js';

const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
function archive(raw, { zlib = {}, descriptor = false, extra = Buffer.alloc(0), centralExtra = Buffer.alloc(0), declared = raw.length } = {}) {
  const compressed = deflateRawSync(raw, zlib), local = Buffer.alloc(31), central = Buffer.alloc(47), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(descriptor ? 8 : 0, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(descriptor ? 0 : compressed.length, 18); local.writeUInt32LE(descriptor ? 0 : declared, 22);
  local.writeUInt16LE(1, 26); local.writeUInt16LE(extra.length, 28); local[30] = 120;
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(descriptor ? 8 : 0, 8);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(declared, 24);
  central.writeUInt16LE(1, 28); central.writeUInt16LE(centralExtra.length, 30); central[46] = 120;
  const receipt = Buffer.alloc(descriptor ? 16 : 0);
  if (descriptor) { receipt.writeUInt32LE(0x08074b50); receipt.writeUInt32LE(compressed.length, 8); receipt.writeUInt32LE(declared, 12); }
  const directory = local.length + extra.length + compressed.length + receipt.length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + centralExtra.length, 12); end.writeUInt32LE(directory, 16);
  const bytes = Buffer.concat([local, extra, compressed, receipt, central, centralExtra, end]);
  return { bytes, directory, end: bytes.length - 22, receipt: directory - receipt.length };
}

test('ZIP preflight agrees with zlib for stored, fixed and dynamic DEFLATE including multiple blocks', () => {
  const payloads = [Buffer.alloc(0), Buffer.from('hello'), Buffer.alloc(150000, 65), randomBytes(150000),
    Buffer.from(Array.from({ length: 4000 }, (_, i) => `会员${i}: 13800000000\n`).join(''))];
  for (const raw of payloads) {
    for (const zlib of [{ level: 0 }, { strategy: constants.Z_FIXED }, { level: 9 }]) {
      for (const descriptor of [false, true]) {
        const { bytes } = archive(raw, { zlib, descriptor });
        assert.doesNotThrow(() => checkZipBudget(arrayBuffer(bytes), raw.length + 1));
      }
    }
  }
});

test('ZIP preflight bounds actual output even when both headers understate the size', () => {
  const { bytes } = archive(Buffer.alloc(4096, 65), { declared: 1 });
  assert.throws(() => checkZipBudget(arrayBuffer(bytes), 1024), /解压数据过大/);
  assert.throws(() => checkZipBudget(arrayBuffer(bytes), 8192), /尺寸无效/);
});

test('ZIP local size forgery is rejected before XLSX requests a large buffer', () => {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['姓名', '手机号'], ['客户', '13800001111']]), '会员');
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true });
  bytes.writeUInt32LE(65 * 1024 * 1024, 22);
  const allocate = Buffer.allocUnsafe; let largest = 0;
  try {
    Buffer.allocUnsafe = function(size) { largest = Math.max(largest, size); assert.ok(size < 1024 * 1024); return allocate.call(Buffer, size); };
    assert.throws(() => parseImportBuffer(arrayBuffer(bytes), false), /解压数据过大/);
    assert.ok(largest < 1024 * 1024);
  } finally { Buffer.allocUnsafe = allocate; }
});

test('ZIP64 size overrides in either header are rejected before inflation', () => {
  const extra = Buffer.alloc(20); extra.writeUInt16LE(1); extra.writeUInt16LE(16, 2); extra.writeBigUInt64LE(65n * 1024n * 1024n, 4);
  for (const options of [{ extra }, { centralExtra: extra }]) {
    const { bytes } = archive(Buffer.from('abc'), options);
    assert.throws(() => checkZipBudget(arrayBuffer(bytes), 64 * 1024 * 1024), /结构或解压尺寸无效/);
  }
});

test('ZIP rejects mismatched entry counts, local headers, descriptors and invalid offsets', () => {
  for (const mutate of [
    ({ bytes, end }) => bytes.writeUInt16LE(0, end + 10),
    ({ bytes }) => bytes.writeUInt16LE(0, 8),
    ({ bytes }) => bytes.writeUInt32LE(999, 18),
    ({ bytes }) => { bytes[30] = 121; },
    ({ bytes, receipt }) => bytes.writeUInt32LE(999, receipt + 12),
    ({ bytes, directory }) => bytes.writeUInt32LE(directory, directory + 42)
  ]) {
    const zip = archive(Buffer.from('abc'), { descriptor: true }); mutate(zip);
    assert.throws(() => checkZipBudget(arrayBuffer(zip.bytes), 1024), /结构或解压尺寸无效/);
  }
});
