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
  const start = lines.findIndex((line, index) => index > step && line.trim().startsWith('run: '));
  assert.ok(step >= 0 && start > step, `Missing workflow step: ${name}`);
  if (lines[start].trim() !== 'run: |') return 'set -e\n' + lines[start].trim().slice(5);
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

test('signing configuration keeps passwords out of later step environments and logs', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const configured = { ...env, SIGNING_KEYSTORE_BASE64: Buffer.from('fixture private signing key').toString('base64'),
    RELEASE_STORE_PASSWORD: 'store-secret\nUNEXPECTED_ENV=injected', RELEASE_KEY_ALIAS: 'release-alias',
    RELEASE_KEY_PASSWORD: 'key-secret', RELEASE_CERT_SHA256: 'a'.repeat(64) };
  const result = run(stepScript('6. 配置发布签名'), directory, configured);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const exported = readFileSync(join(directory, 'github-env'), 'utf8');
  const entries = exported.trim().split('\n');
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^RELEASE_STORE_FILE=.*\/hairstudio-release\.jks$/);
  for (const secret of [configured.RELEASE_STORE_PASSWORD, configured.RELEASE_KEY_PASSWORD, configured.SIGNING_KEYSTORE_BASE64]) {
    assert.ok(!exported.includes(secret));
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  assert.ok(!exported.includes('UNEXPECTED_ENV'));
});

test('credential cleanup removes signing and deployment keys and is safe to retry', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  for (const name of ['hairstudio-release.jks', 'member-deploy-key', 'member-deploy-known-hosts', 'unrelated']) {
    writeFileSync(join(directory, name), 'fixture');
  }
  const cleanup = stepScript('清理发布签名临时文件') + '\n' + stepScript('清理 SSH 部署临时凭据');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(cleanup, directory, env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const name of ['hairstudio-release.jks', 'member-deploy-key', 'member-deploy-known-hosts']) {
      assert.equal(existsSync(join(directory, name)), false);
    }
    assert.equal(readFileSync(join(directory, 'unrelated'), 'utf8'), 'fixture');
  }
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

test('APK certificate verification supports V2 Signer format and colon delimiters', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const toolsDirectory = join(directory, 'build-tools', '35.0.0');
  mkdirSync(toolsDirectory, { recursive: true });
  const rawFingerprint = 'da28115caa57eedb2e6adf802a8348209e5190d91b5b6767bb6a3119ad6a0041';
  const colonFingerprint = rawFingerprint.match(/.{2}/g).join(':');
  writeFileSync(join(toolsDirectory, 'apksigner'), `#!/bin/sh\nprintf '%s\\n' 'V2 Signer: certificate SHA-256 digest: ${rawFingerprint}'\n`, { mode: 0o755 });
  const configured = { ...env, ANDROID_HOME: directory.replaceAll('\\', '/'), RELEASE_CERT_SHA256: colonFingerprint };
  const script = stepScript('9. 校验 APK 签名');
  const matching = run(script, directory, configured);
  assert.equal(matching.status, 0, matching.stdout + matching.stderr);
});

test('update-manifest accepts V2 Signer certificate output and generates manifest', t => {
  const { directory } = fixture(t);
  const rawFingerprint = 'da28115caa57eedb2e6adf802a8348209e5190d91b5b6767bb6a3119ad6a0041';
  const apksignerScript = join(directory, process.platform === 'win32' ? 'apksigner.cmd' : 'apksigner');
  const dummyApk = join(directory, 'app-release.apk');
  const manifestOutput = join(directory, 'manifest.json');
  if (process.platform === 'win32') {
    writeFileSync(apksignerScript, `@echo V2 Signer: certificate SHA-256 digest: ${rawFingerprint}\r\n`);
  } else {
    writeFileSync(apksignerScript, `#!/bin/sh\nprintf '%s\\n' 'V2 Signer: certificate SHA-256 digest: ${rawFingerprint}'\n`, { mode: 0o755 });
  }
  writeFileSync(dummyApk, 'fake apk bytes');
  const result = spawnSync(process.execPath, [resolve('tools/update-manifest.js'), dummyApk, manifestOutput], {
    env: {
      ...process.env,
      APKSIGNER: apksignerScript,
      RELEASE_CERT_SHA256: rawFingerprint.toUpperCase(),
      VERSION_CODE: '10',
      VERSION_NAME: '1.0.10'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const saved = JSON.parse(readFileSync(manifestOutput, 'utf8'));
  assert.equal(saved.versionCode, 10);
  assert.equal(saved.versionName, '1.0.10');
  assert.equal(saved.certificateSha256, rawFingerprint);
});
