import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') return findTests(path);
    return entry.isFile() && /\.test\.[cm]?js$/.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

// Deployment fixtures can contain copied tests. Discover only the source suites,
// and pass explicit paths so Node never falls back to scanning the workspace.
const files = (await Promise.all(['tests', 'server/tests'].map(directory => findTests(join(root, directory))))).flat().sort();
if (!files.length) throw new Error('No test files found in tests/ or server/tests/');

const runner = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
runner.on('error', error => { console.error(error.message); process.exitCode = 1; });
runner.on('exit', code => { process.exitCode = code ?? 1; });
