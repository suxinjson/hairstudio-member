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
function stepBlock(name) {
  const lines = workflow.split('\n'), start = lines.findIndex(line => line.includes(name));
  assert.ok(start >= 0, 'Missing workflow step: ' + name);
  let end = start + 1;
  while (end < lines.length && !/^    - name:/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n');
}
function expression(text, key, context = {}) {
  const raw = text.match(new RegExp('^\\s+' + key + ': \\$\\{\\{ (.+) \\}\\}', 'm'))?.[1];
  assert.ok(raw, 'Missing expression: ' + key);
  return new Function('github', 'inputs', 'vars', 'env', 'secrets', 'format', 'return (' + raw + ')')(
    context.github || {}, context.inputs || {}, context.vars || {}, context.env || {}, context.secrets || {},
    (pattern, value) => pattern.replace('{0}', value));
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
    GITHUB_STEP_SUMMARY: unix(join(directory, 'github-summary')), GITHUB_REF: 'refs/heads/main',
    SERVER_ONLY_REQUESTED: 'false', SERVER_ONLY_APPROVED: 'false', SERVER_DEPLOY_ENABLED: 'true',
    RELEASE_APPROVED: 'false', RELEASE_REQUESTED: 'false',
    SIGNING_KEYSTORE_BASE64: '', RELEASE_STORE_PASSWORD: '', RELEASE_KEY_ALIAS: '', RELEASE_KEY_PASSWORD: '', RELEASE_CERT_SHA256: ''
  } };
}
function run(script, directory, env) {
  return spawnSync(bash, ['--noprofile', '--norc', '-c', script], { cwd: directory, env, encoding: 'utf8' });
}

test('manual APK compilation and artifact upload do not depend on server publication approval', () => {
  assert.match(workflow, /apk_type:[\s\S]*?default: release/);
  assert.match(workflow, /operation:[\s\S]*?default: build_apk/);
  for (const name of ['8. 编译 Android 安装包与测试', '10. 收集生成好的 APK']) {
    assert.equal(expression(stepBlock(name), 'if', { env: { SERVER_ONLY_REQUESTED: 'false' } }), true);
    assert.equal(expression(stepBlock(name), 'if', { env: { SERVER_ONLY_REQUESTED: 'true' } }), false);
  }
  assert.doesNotMatch(stepBlock('12. 上传安装包与服务端更新产物供备用下载'), /^\s+if:/m);
  assert.match(stepBlock('12. 上传安装包与服务端更新产物供备用下载'), /if-no-files-found: error/);
  for (const event_name of ['push', 'workflow_dispatch'])
    for (const ref of ['refs/heads/main', 'refs/heads/master', 'refs/heads/feature'])
      for (const apk_type of ['release', 'debug'])
        for (const operation of ['build_apk', 'deploy_server', 'deploy_server_and_app'])
          for (const approved of [undefined, 'false', 'true']) {
            const context = { github: { event_name, ref }, inputs: { apk_type, operation }, vars: { RELATIONAL_RELEASE_APPROVED: approved } };
            const variant = expression(workflow, 'APK_VARIANT', context);
            const publication = expression(workflow, 'RELEASE_APPROVED', context);
            const serverOnly = expression(workflow, 'SERVER_ONLY_APPROVED', context);
            assert.equal(variant, event_name === 'workflow_dispatch' && (apk_type === 'release' || operation === 'deploy_server_and_app') ? 'release' : 'debug');
            assert.equal(publication, event_name === 'workflow_dispatch' && operation === 'deploy_server_and_app' && approved === 'true' && ref !== 'refs/heads/feature');
            assert.equal(serverOnly, event_name === 'workflow_dispatch' && operation === 'deploy_server' && approved === 'true' && ref !== 'refs/heads/feature');
            const env = { APK_VARIANT: variant, RELEASE_APPROVED: String(publication), SERVER_ONLY_APPROVED: String(serverOnly), SERVER_DEPLOY_ENABLED: 'true' };
            assert.equal(expression(stepBlock('11. 打包生成服务器更新包'), 'if', { env }), publication || serverOnly);
            assert.equal(expression(stepBlock('13. [方案B] 自动 SSH'), 'if', { env }), publication || serverOnly);
          }
});

test('debug builds never receive fixed signing passwords and artifact names identify the chosen package', () => {
  const step = stepBlock('8. 编译 Android 安装包与测试');
  const secrets = { RELEASE_STORE_PASSWORD: 'synthetic-store', RELEASE_KEY_ALIAS: 'synthetic-alias', RELEASE_KEY_PASSWORD: 'synthetic-key' };
  for (const APK_VARIANT of ['debug', 'release']) {
    for (const key of Object.keys(secrets)) assert.equal(expression(step, key, { env: { APK_VARIANT }, secrets }), APK_VARIANT === 'release' ? secrets[key] : '');
    assert.equal(expression(stepBlock('12. 上传安装包与服务端更新产物供备用下载'), 'name', { env: { APK_VARIANT, VERSION_NAME: '1.0.95' } }),
      APK_VARIANT === 'release' ? 'member-manager-1.0.95' : 'member-manager-debug-1.0.95');
  }
  for (const key of Object.keys(secrets)) assert.equal(expression(step, key, { env: { APK_VARIANT: 'release', SERVER_ONLY_REQUESTED: 'true' }, secrets }), '');
  assert.equal(expression(stepBlock('12. 上传安装包与服务端更新产物供备用下载'), 'name', { env: { APK_VARIANT: 'release', SERVER_ONLY_REQUESTED: 'true', VERSION_NAME: '1.0.95' } }), 'member-server-1.0.95');
});

test('server-only preflight requires approval and SSH but not APK signing credentials', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const configured = { ...env, APK_VARIANT: 'release', SERVER_ONLY_REQUESTED: 'true' };
  const script = stepScript('检查安装包类型与发布状态');
  assert.notEqual(run(script, directory, configured).status, 0);
  assert.notEqual(run(script, directory, { ...configured, SERVER_ONLY_APPROVED: 'true', SERVER_DEPLOY_ENABLED: 'false' }).status, 0);
  const allowed = run(script, directory, { ...configured, SERVER_ONLY_APPROVED: 'true' });
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.ok(readFileSync(join(directory, 'github-summary'), 'utf8').includes('不发布手机版更新'));
  for (const name of ['6. 配置发布签名', '7. 接受 Android SDK', '8. 编译 Android', '9. 校验 APK', '10. 收集生成好的 APK']) {
    assert.equal(expression(stepBlock(name), 'if', { env: configured }), false);
  }
});

test('formal package branch checks report an error while debug packages allow feature branches', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  const configured = { ...env, APK_VARIANT: 'release', RELEASE_APPROVED: 'false', RELEASE_REQUESTED: 'false' };
  for (const GITHUB_REF of ['refs/heads/main', 'refs/heads/master', 'refs/heads/feature']) {
    const result = run(stepScript('检查安装包类型与发布状态'), directory, { ...configured, GITHUB_REF });
    assert.equal(result.status, GITHUB_REF === 'refs/heads/feature' ? 1 : 0, result.stdout + result.stderr);
  }
  assert.equal(run(stepScript('检查安装包类型与发布状态'), directory, { ...configured, APK_VARIANT: 'debug', GITHUB_REF: 'refs/heads/feature' }).status, 0);
  assert.ok(readFileSync(join(directory, 'github-summary'), 'utf8').includes('Artifacts'));
});

test('both APK modes compile native tests and collect downloadable files without publication approval', { skip: !bashAvailable }, t => {
  for (const APK_VARIANT of ['release', 'debug']) {
    const { directory, env } = fixture(t);
    mkdirSync(join(directory, 'android'), { recursive: true });
    mkdirSync(join(directory, 'build-tools', '35.0.0'), { recursive: true });
    writeFileSync(join(directory, 'build-tools', '35.0.0', 'apksigner'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(directory, 'android', 'gradlew'), '#!/usr/bin/env bash\nset -e\nprintf "%s\\n" "$*" > ../gradle-calls\n' +
      'if [[ "$*" == *:app:assembleRelease* ]]; then variant=release; else variant=debug; fi\n' +
      'mkdir -p "app/build/outputs/apk/$variant"\nprintf "synthetic APK %s" "$variant" > "app/build/outputs/apk/$variant/app-$variant.apk"\n', { mode: 0o755 });
    const script = stepScript('8. 编译 Android 安装包与测试') + '\ncd ..\n' +
      'node() { printf "%s\\n" "$*" >> manifest-calls; printf "{}\\n" > "$3"; }\n' + stepScript('10. 收集生成好的 APK');
    const result = run(script, directory, { ...env, APK_VARIANT, RELEASE_APPROVED: 'false', VERSION_NAME: '1.0.95', VERSION_CODE: '95', ANDROID_HOME: directory.replaceAll('\\', '/') });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = readFileSync(join(directory, 'gradle-calls'), 'utf8');
    assert.ok(calls.includes(':app:assemble' + (APK_VARIANT === 'release' ? 'Release' : 'Debug')));
    assert.ok(calls.includes(':app:testDebugUnitTest'));
    assert.ok(calls.includes(':app:compileDebugAndroidTestJavaWithJavac'));
    assert.equal(calls.includes(':app:validateReleaseSigning'), APK_VARIANT === 'release');
    const apk = 'member-manager-' + (APK_VARIANT === 'debug' ? 'debug-' : '') + 'v1.0.95.apk';
    assert.equal(readFileSync(join(directory, 'output_apk', apk), 'utf8'), 'synthetic APK ' + APK_VARIANT);
    assert.equal(existsSync(join(directory, 'output_apk', 'update-manifest.json')), APK_VARIANT === 'release');
    assert.equal(existsSync(join(directory, 'manifest-calls')), APK_VARIANT === 'release');
    assert.ok(readFileSync(join(directory, 'github-summary'), 'utf8').includes(apk));
  }
});

function runGradleAttempts(t, attempts, variant = 'release', prefix = '') {
  const { directory, env } = fixture(t);
  mkdirSync(join(directory, 'android'));
  attempts.forEach((attempt, index) => {
    writeFileSync(join(directory, `gradle-output-${index + 1}`), attempt.output);
    writeFileSync(join(directory, `gradle-status-${index + 1}`), String(attempt.status));
  });
  writeFileSync(join(directory, 'android', 'gradlew'), '#!/usr/bin/env bash\nset -e\n' +
    'printf "%s\\n" "$*" >> ../gradle-calls\n' +
    'attempt=$(wc -l < ../gradle-calls)\ncat "../gradle-output-$attempt"\nexit "$(cat "../gradle-status-$attempt")"\n', { mode: 0o755 });
  const result = run('sleep() { printf "%s\\n" "$*" >> ../gradle-waits; }\n' + prefix + stepScript('8. 编译 Android 安装包与测试'),
    directory, { ...env, APK_VARIANT: variant });
  const lines = name => existsSync(join(directory, name)) ? readFileSync(join(directory, name), 'utf8').trim().split('\n') : [];
  return { ...result, calls: lines('gradle-calls'), waits: lines('gradle-waits') };
}
const repositoryFailure = status => `Could not GET 'https://repo.maven.apache.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom'. Received status code ${status} from server: repository error\n`;

test('Android repository rate limits and transient HTTP errors retry the original build with backoff', { skip: !bashAvailable }, t => {
  for (const variant of ['release', 'debug']) {
    for (const status of [429, 502, 503, 504]) {
      const result = runGradleAttempts(t, [
        { status: 7, output: repositoryFailure(status) },
        { status: 7, output: repositoryFailure(status) },
        { status: 0, output: 'BUILD SUCCESSFUL\n' }
      ], variant);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.calls.length, 3);
      assert.equal(new Set(result.calls).size, 1);
      assert.ok(result.calls[0].includes(':app:assemble' + (variant === 'release' ? 'Release' : 'Debug')));
      assert.ok(result.calls[0].includes(':app:testDebugUnitTest :app:compileDebugAndroidTestJavaWithJavac'));
      assert.deepEqual(result.waits, ['30', '60']);
    }
  }
});

test('persistent Android dependency rate limits stop after three attempts and preserve the Gradle exit code', { skip: !bashAvailable }, t => {
  const result = runGradleAttempts(t, Array(3).fill({ status: 7, output: repositoryFailure(429) }));
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.equal(result.calls.length, 3);
  assert.deepEqual(result.waits, ['30', '60']);
});

test('Java, test, signing, authorization and missing-artifact errors fail without a retry', { skip: !bashAvailable }, t => {
  for (const output of [':app:compileReleaseJavaWithJavac FAILED', ':app:testDebugUnitTest FAILED', 'Release keystore does not exist',
    repositoryFailure(401), repositoryFailure(403), repositoryFailure(404)]) {
    const result = runGradleAttempts(t, [{ status: 9, output }]);
    assert.equal(result.status, 9, result.stdout + result.stderr);
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.waits, []);
  }
  const changed = runGradleAttempts(t, [{ status: 7, output: repositoryFailure(429) }, { status: 9, output: ':app:compileReleaseJavaWithJavac FAILED' }]);
  assert.equal(changed.status, 9, changed.stdout + changed.stderr);
  assert.equal(changed.calls.length, 2);
  assert.deepEqual(changed.waits, ['30']);
});

test('failure to capture the Android build log cannot turn the pipeline into a success', { skip: !bashAvailable }, t => {
  const result = runGradleAttempts(t, [{ status: 0, output: 'BUILD SUCCESSFUL\n' }], 'debug', 'tee() { cat; return 23; }\n');
  assert.equal(result.status, 23, result.stdout + result.stderr);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.waits, []);
});

test('missing compiled APK fails collection instead of uploading an empty or wrong variant artifact', { skip: !bashAvailable }, t => {
  const { directory, env } = fixture(t);
  mkdirSync(join(directory, 'android', 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true });
  writeFileSync(join(directory, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), 'wrong variant');
  const result = run(stepScript('10. 收集生成好的 APK'), directory, { ...env, APK_VARIANT: 'release', VERSION_NAME: '1.0.95' });
  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes('未找到本次编译的安装包'));
  assert.equal(existsSync(join(directory, 'output_apk', 'member-manager-v1.0.95.apk')), false);
});

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
