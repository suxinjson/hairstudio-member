import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const javaTool = name => process.env.JAVA_HOME
  ? join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const javac = javaTool('javac'), java = javaTool('java');
const hasJdk = spawnSync(javac, ['-version'], { encoding: 'utf8' }).status === 0;

test('native vault never restores a stale copy after partial key failures and restart', { skip: !hasJdk && 'JDK required' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'member-vault-test-'));
  try {
    const compiled = spawnSync(javac, ['-d', directory,
      fileURLToPath(new URL('../android/app/src/main/java/com/hairstudio/memberapp/VaultCopies.java', import.meta.url)),
      fileURLToPath(new URL('./fixtures/java/VaultCopiesRegression.java', import.meta.url))
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const verified = spawnSync(java, ['-ea', '-cp', directory, 'com.hairstudio.memberapp.VaultCopiesRegression'], {
      encoding: 'utf8', timeout: 30000
    });
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    assert.match(verified.stdout, /fault scenarios passed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
