import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const workflow = readFileSync(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function stepScript(name) {
  const lines = workflow.split('\n');
  const step = lines.findIndex(line => line.includes(name));
  const start = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  const script = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index] && !lines[index].startsWith('        ')) break;
    script.push(lines[index].slice(8));
  }
  return 'set -e\n' + script.join('\n');
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'member-signing-test-'));
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true });
  });
  const unix = path => path.replaceAll('\\', '/');
  return { directory, env: {
    ...process.env, RUNNER_TEMP: unix(directory), GITHUB_ENV: unix(join(directory, 'github-env')),
    SIGNING_KEYSTORE_BASE64: '', RELEASE_STORE_PASSWORD: '', RELEASE_KEY_ALIAS: '', RELEASE_KEY_PASSWORD: '', RELEASE_CERT_SHA256: ''
  } };
}
function run(script, directory, env) {
  return spawnSync(bash, ['--noprofile', '--norc', '-c', script], { cwd: directory, env, encoding: 'utf8' });
}

test('release signing refuses missing credentials or fingerprint and never generates a fallback key', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const script = stepScript('6. 配置发布签名');
  for (const missing of ['SIGNING_KEYSTORE_BASE64', 'RELEASE_STORE_PASSWORD', 'RELEASE_KEY_ALIAS', 'RELEASE_KEY_PASSWORD', 'RELEASE_CERT_SHA256']) {
    const configured = { ...env, SIGNING_KEYSTORE_BASE64: Buffer.from('fixture key').toString('base64'),
      RELEASE_STORE_PASSWORD: 'fixture', RELEASE_KEY_ALIAS: 'fixture', RELEASE_KEY_PASSWORD: 'fixture', RELEASE_CERT_SHA256: 'a'.repeat(64) };
    configured[missing] = '';
    const result = run(script, directory, configured);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes(`Missing ${missing}`));
    assert.equal(existsSync(join(directory, 'hairstudio-release.jks')), false);
  }
});

test('release signing accepts only a valid fixed certificate fingerprint', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const configured = { ...env, SIGNING_KEYSTORE_BASE64: Buffer.from('fixture key').toString('base64'),
    RELEASE_STORE_PASSWORD: 'fixture', RELEASE_KEY_ALIAS: 'fixture', RELEASE_KEY_PASSWORD: 'fixture', RELEASE_CERT_SHA256: 'bad' };
  const script = stepScript('6. 配置发布签名');
  assert.notEqual(run(script, directory, configured).status, 0);
  configured.RELEASE_CERT_SHA256 = 'AB:'.repeat(31) + 'AB';
  const result = run(script, directory, configured);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(directory, 'hairstudio-release.jks'), 'utf8'), 'fixture key');
});

test('APK certificate mismatch prevents publication', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const toolsDirectory = join(directory, 'build-tools', '35.0.0');
  mkdirSync(toolsDirectory, { recursive: true });
  writeFileSync(join(toolsDirectory, 'apksigner'), `#!/bin/sh\nprintf '%s\\n' 'Signer #1 certificate SHA-256 digest: ${'a'.repeat(64)}'\n`, { mode: 0o755 });
  const configured = { ...env, ANDROID_HOME: directory.replaceAll('\\', '/'), RELEASE_CERT_SHA256: 'b'.repeat(64) };
  const script = stepScript('9. 校验 APK 签名');
  const mismatch = run(script, directory, configured);
  assert.notEqual(mismatch.status, 0);
  assert.ok(mismatch.stdout.includes('does not match'), mismatch.stdout + mismatch.stderr);
  configured.RELEASE_CERT_SHA256 = 'a'.repeat(64);
  const matching = run(script, directory, configured);
  assert.equal(matching.status, 0, matching.stdout + matching.stderr);
});
