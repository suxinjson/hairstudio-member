import { createHash, randomUUID } from 'node:crypto';

// In-memory provider double, deliberately separate from production SAF code.
export function archiveDocumentPlugin(initial = new Uint8Array()) {
  let file = Buffer.from(initial), parts = [], token, kind, sequence = 0, length = 0, position = 0;
  const calls = [];
  const digest = () => createHash('sha256').update(file).digest('hex');
  function capture(input) { if (!token || input.token !== token) throw new Error('lost capture'); }
  const plugin = {
    async create(input) { calls.push(['create', input]); token = randomUUID(); kind = 'write'; return { token, fileName: input.fileName }; },
    async choose(input) { calls.push(['choose', input]); token = randomUUID(); kind = 'read'; return { token, fileName: 'book.ndjson' }; },
    async beginWrite(input) { capture(input); if (kind !== 'write') throw new Error('not writer'); parts = []; sequence = length = 0; return { sequence, byteLength: length }; },
    async writeChunk(input) { capture(input); const bytes = Buffer.from(input.data, 'base64'); if (input.sequence !== sequence || bytes.length > 65536) throw new Error('write sequence'); calls.push(['writeChunk', bytes.length]); parts.push(bytes); length += bytes.length; return { sequence: sequence++, byteLength: length }; },
    async beginVerify(input) { capture(input); file = Buffer.concat(parts); calls.push(['beginVerify']); return { verifying: true, byteLength: file.length, sha256: digest() }; },
    async verifyChunk(input) { capture(input); calls.push(['verifyChunk']); token = null; return { status: 'saved-verified', fileName: 'book.ndjson', byteLength: file.length, sha256: digest() }; },
    async beginRead(input) { capture(input); position = sequence = 0; calls.push(['beginRead']); return { sequence, byteLength: position }; },
    async readChunk(input) {
      capture(input); if (input.sequence !== sequence) throw new Error('read sequence'); calls.push(['readChunk']);
      if (position === file.length) return { sequence: sequence++, done: true, byteLength: position, sha256: digest() };
      const bytes = file.subarray(position, position + 65536); position += bytes.length;
      return { sequence: sequence++, done: false, byteLength: position, data: bytes.toString('base64') };
    },
    async close(input) { capture(input); calls.push(['close']); token = null; return { closed: true }; },
    async cancel(input) { calls.push(['cancel', input]); if (!input.token || input.token === token) token = null; return { cancelRequested: true }; }
  };
  return { plugin, calls, get bytes() { return Buffer.from(file); }, set bytes(value) { file = Buffer.from(value); } };
}
