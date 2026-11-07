// Validate sizes without materializing the inflated data. XLSX trusts local headers
// and checks their agreement with the directory only after allocating buffers.
function invalid() { throw new Error('Excel 压缩文件结构或解压尺寸无效'); }
function oversized() { throw new Error('Excel 解压数据过大，请分批导入'); }

function huffman(lengths) {
  const counts = new Array(16).fill(0), tables = Array.from({ length: 16 }, () => new Map());
  for (const length of lengths) { if (length < 0 || length > 15) invalid(); if (length) counts[length]++; }
  let available = 1, code = 0;
  const next = new Array(16).fill(0);
  for (let length = 1; length <= 15; length++) {
    available = available * 2 - counts[length];
    if (available < 0) invalid();
    code = (code + counts[length - 1]) * 2; next[length] = code;
  }
  lengths.forEach((length, symbol) => { if (length) tables[length].set(next[length]++, symbol); });
  return tables;
}
const fixedLiteral = huffman(Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8));
const fixedDistance = huffman(new Array(32).fill(5));
const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const distanceBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const codeOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function deflateSize(bytes, maximum) {
  let bit = 0, size = 0;
  function read(count) {
    if (bit + count > bytes.length * 8) invalid();
    let value = 0;
    for (let i = 0; i < count; i++, bit++) value |= ((bytes[bit >>> 3] >>> (bit & 7)) & 1) << i;
    return value;
  }
  function symbol(tree) {
    let code = 0;
    for (let length = 1; length <= 15; length++) {
      code = code * 2 + read(1);
      const value = tree[length].get(code);
      if (value !== undefined) return value;
    }
    invalid();
  }
  function add(count) { size += count; if (size > maximum) oversized(); }
  let final;
  do {
    final = read(1);
    const type = read(2);
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8;
      const count = read(16);
      if ((count ^ read(16)) !== 0xffff || bit + count * 8 > bytes.length * 8) invalid();
      add(count); bit += count * 8; continue;
    }
    if (type === 3) invalid();
    let literals = fixedLiteral, distances = fixedDistance;
    if (type === 2) {
      const literalCount = read(5) + 257, distanceCount = read(5) + 1, codeCount = read(4) + 4;
      if (literalCount > 286) invalid();
      const codeLengths = new Array(19).fill(0);
      for (let i = 0; i < codeCount; i++) codeLengths[codeOrder[i]] = read(3);
      const codes = huffman(codeLengths), lengths = [];
      while (lengths.length < literalCount + distanceCount) {
        const value = symbol(codes);
        if (value < 16) lengths.push(value);
        else {
          if (value === 16 && !lengths.length) invalid();
          const repeat = value === 16 ? read(2) + 3 : value === 17 ? read(3) + 3 : read(7) + 11;
          const previous = value === 16 ? lengths.at(-1) : 0;
          if (lengths.length + repeat > literalCount + distanceCount) invalid();
          for (let i = 0; i < repeat; i++) lengths.push(previous);
        }
      }
      if (!lengths[256]) invalid();
      literals = huffman(lengths.slice(0, literalCount)); distances = huffman(lengths.slice(literalCount));
    }
    for (;;) {
      const value = symbol(literals);
      if (value < 256) { add(1); continue; }
      if (value === 256) break;
      if (value > 285) invalid();
      const length = lengthBase[value - 257] + read(lengthExtra[value - 257]);
      const distance = symbol(distances);
      if (distance > 29) invalid();
      const extra = distance < 4 ? 0 : (distance >>> 1) - 1;
      if (distanceBase[distance] + read(extra) > size) invalid();
      add(length);
    }
  } while (!final);
  if (Math.ceil(bit / 8) !== bytes.length) invalid();
  return size;
}

export function checkZipBudget(buffer, maximum) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return; // Legacy .xls uses CFB, not ZIP.
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) invalid();
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) invalid();
  // XLSX searches backwards for this signature, including inside ZIP comments.
  for (let i = end + 22; i + 4 <= bytes.length; i++) if (view.getUint32(i, true) === 0x06054b50) invalid();
  const entries = view.getUint16(end + 10, true), directory = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) ||
      entries !== view.getUint16(end + 8, true) || !entries || entries > 2048 || directory + view.getUint32(end + 12, true) !== end) invalid();
  function extra(start, length) {
    const stop = start + length;
    while (start < stop) {
      if (start + 4 > stop) invalid();
      // ZIP64 cannot be needed within the import limits. Never let it override checked sizes.
      if (view.getUint16(start, true) === 1) invalid();
      start += 4 + view.getUint16(start + 2, true);
      if (start > stop) invalid();
    }
  }
  let offset = directory, expanded = 0;
  const spans = [];
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) invalid();
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true);
    expanded += size; if (expanded > maximum) oversized();
    const name = view.getUint16(offset + 28, true), extras = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true), next = offset + 46 + name + extras + comment;
    if (next > end || view.getUint16(offset + 34, true) || flags & 0x2041 || ![0, 8].includes(method)) invalid();
    extra(offset + 46 + name, extras);
    if (local + 30 > directory || view.getUint32(local, true) !== 0x04034b50 ||
        view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method || view.getUint16(local + 26, true) !== name) invalid();
    const localExtra = view.getUint16(local + 28, true), data = local + 30 + name + localExtra, stop = data + compressed;
    if (stop > directory) invalid();
    extra(local + 30 + name, localExtra);
    for (let j = 0; j < name; j++) if (bytes[local + 30 + j] !== bytes[offset + 46 + j]) invalid();
    const localCompressed = view.getUint32(local + 18, true), localSize = view.getUint32(local + 22, true);
    if (localSize > maximum) oversized();
    if (localCompressed !== compressed && (!(flags & 8) || localCompressed !== 0) ||
        localSize !== size && (!(flags & 8) || localSize !== 0)) invalid();
    let spanEnd = stop;
    if (flags & 8) {
      if (spanEnd + 12 > directory) invalid();
      if (view.getUint32(spanEnd, true) === 0x08074b50) spanEnd += 4;
      if (spanEnd + 12 > directory || view.getUint32(spanEnd, true) !== view.getUint32(offset + 16, true) ||
          view.getUint32(spanEnd + 4, true) !== compressed || view.getUint32(spanEnd + 8, true) !== size) invalid();
      spanEnd += 12;
    }
    const actual = method === 0 ? compressed : deflateSize(bytes.subarray(data, stop), maximum - (expanded - size));
    if (actual !== size) invalid();
    spans.push([local, spanEnd]); offset = next;
  }
  if (offset !== end) invalid();
  spans.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) invalid();
}
