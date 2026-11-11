import { lstat, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const generated = [
  'tmp', 'output', 'dist', 'admin/dist',
  'node_modules/.vite', 'admin/node_modules/.vite',
  'android/.gradle', 'android/build', 'android/app/build'
];
const targets = [];
for (const name of generated) {
  const target = resolve(root, name), path = relative(root, target);
  if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('清理路径超出项目目录：' + name);
  // Verify every path before deleting anything; never traverse a linked directory.
  let missing = false;
  for (let current = target; current !== root; current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('清理路径包含符号链接：' + name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
    }
  }
  if (!missing) targets.push({ name, target });
}
for (const { name, target } of targets) {
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  console.log('已清理：' + name);
}
console.log('清理完成，共 ' + targets.length + ' 个目录。');
