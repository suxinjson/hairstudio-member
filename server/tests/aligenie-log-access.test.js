import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const reader = fileURLToPath(new URL('../../deploy/read-aligenie-logs.sh', import.meta.url)).replaceAll('\\', '/');
const setup = fileURLToPath(new URL('../../deploy/setup-aligenie-log-access.sh', import.meta.url)).replaceAll('\\', '/');

test('log reader and public-key setup scripts have valid Bash syntax', () => {
  for (const script of [reader, setup]) {
    const result = spawnSync(bash, ['-n', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('forced SSH log reads reject arbitrary commands, shell injection and unbounded arguments before Docker', () => {
  for (const command of ['whoami', 'aligenie-logs --tail 0', 'aligenie-logs --tail 1001',
    'aligenie-logs --tail 10;id', 'aligenie-logs --since 1h;id', 'aligenie-logs --since 25h',
    'aligenie-logs --since 100m', 'aligenie-logs --project-directory /etc', 'aligenie-logs --tail']) {
    const result = spawnSync(bash, [reader], { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' });
    assert.equal(result.status, 64, `${command}: ${result.stderr}`);
  }
});

test('public-key setup rejects invalid input before touching SSH configuration', () => {
  for (const value of ['', '-----BEGIN OPENSSH PRIVATE KEY-----', 'ssh-ed25519 invalid-key']) {
    const result = spawnSync(bash, [setup, value], { encoding: 'utf8' });
    assert.equal(result.status, 64, result.stderr);
  }
});
