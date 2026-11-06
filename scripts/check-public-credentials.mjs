import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertUnexposedCredential } from '../server/exposed-credentials.js';

async function checkDirectory(directory) {
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { files += await checkDirectory(path); continue; }
    if (!/\.(?:js|mjs|vue|html|css|json)$/.test(entry.name)) continue;
    const source = await readFile(path, 'utf8');
    const tokens = source.match(/[A-Za-z0-9_-]{40,256}/g) || [];
    const literals = [...source.matchAll(/['"`]([^'"`\r\n]{40,256})['"`]/g)].map(match => match[1]);
    for (const value of [...tokens, ...literals]) {
      try { assertUnexposedCredential(value); }
      catch { throw new Error('公开资源仍包含历史泄漏凭据：' + path); }
    }
    files++;
  }
  return files;
}
const directories = process.argv.slice(2);
let total = 0;
for (const directory of directories.length ? directories : ['admin/src', 'admin/dist', 'dist']) total += await checkDirectory(resolve(directory));
console.log(`已检查 ${total} 个公开资源文件，未发现历史泄漏凭据。`);
