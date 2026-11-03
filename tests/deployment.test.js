import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const unix = path => path.replaceAll('\\', '/');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-deployment-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true });
  });
  return directory;
}

function run(script, cwd, env = {}) {
  return spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000
  });
}

async function deployment(t, { domain = 'member.example.com', validationFails = false, health = 'ok', ipConfig = true } = {}) {
  const directory = await fixture(t), bin = join(directory, 'bin');
  await Promise.all([mkdir(bin), mkdir(join(directory, 'deploy')), mkdir(join(directory, 'releases'))]);
  await Promise.all([
    writeFile(join(directory, '.env'), `PUBLIC_DOMAIN=${domain}\n`),
    writeFile(join(directory, 'compose.yaml'), 'services: {}\n'),
    writeFile(join(directory, 'releases/hairstudio-member-v1.0.1.apk'), 'test-apk'),
    writeFile(join(directory, 'releases/update-manifest.json'), '{}'),
    writeFile(join(directory, 'deploy/deploy-update.sh'), (await readFile(new URL('../deploy/deploy-update.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')),
    writeFile(join(bin, 'docker'), `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$REVIEW_LOG"
if [ "$1" = info ]; then exit 1; fi
if [[ "$*" == *"caddy validate"* ]] && [ "$REVIEW_VALIDATION_FAILS" = 1 ]; then exit 1; fi
exit 0
`, { mode: 0o755 }),
    // Simulate an existing Certbot directory without touching the host filesystem.
    writeFile(join(bin, 'sudo'), `#!/usr/bin/env bash
if [ "$1" = test ]; then exit 0; fi
exec "$@"
`, { mode: 0o755 }),
    writeFile(join(bin, 'curl'), `#!/usr/bin/env bash
printf 'curl\\n' >> "$REVIEW_LOG"
count=0
if [ -f "$REVIEW_COUNT" ]; then read -r count < "$REVIEW_COUNT"; fi
count=$((count+1))
printf '%s\\n' "$count" > "$REVIEW_COUNT"
if [ "$REVIEW_HEALTH" = failed ]; then exit 22; fi
if [ "$REVIEW_HEALTH" = transient ] && [ "$count" -lt 3 ]; then exit 22; fi
if [ "$REVIEW_HEALTH" = redirect ]; then printf '302'; else printf '200'; fi
`, { mode: 0o755 }),
    writeFile(join(bin, 'sleep'), '#!/usr/bin/env bash\nprintf "sleep\\n" >> "$REVIEW_LOG"\n', { mode: 0o755 })
  ]);
  if (ipConfig) await writeFile(join(directory, 'deploy/compose.ip.yaml'), 'services: {}\n');
  const result = run('export PATH="$REVIEW_BIN:$PATH"\nsource deploy/deploy-update.sh', directory, {
    REVIEW_BIN: process.platform === 'win32' ? unix(bin).replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : bin,
    REVIEW_LOG: unix(join(directory, 'commands.log')), REVIEW_COUNT: unix(join(directory, 'health-count')),
    REVIEW_VALIDATION_FAILS: validationFails ? '1' : '0', REVIEW_HEALTH: health
  });
  const commands = await readFile(join(directory, 'commands.log'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  return { ...result, commands };
}

test('domain deployment keeps the standard Caddy configuration when Certbot is installed', { skip: !bashAvailable }, async t => {
  const result = await deployment(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.commands.includes('compose.ip.yaml'));
  assert.ok(result.commands.includes('server/publish-release.js'));
  assert.ok(result.commands.indexOf('curl\n') < result.commands.indexOf('server/publish-release.js'));
});

test('IPv4 deployment consistently loads the IP certificate configuration', { skip: !bashAvailable }, async t => {
  const result = await deployment(t, { domain: '124.70.184.136' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const composeCalls = result.commands.split('\n').filter(line => line.startsWith('docker compose '));
  assert.ok(composeCalls.length >= 3);
  assert.ok(composeCalls.every(line => line.includes('-f compose.yaml -f deploy/compose.ip.yaml')));
});

test('missing IP certificate configuration stops before restarting containers', { skip: !bashAvailable }, async t => {
  const result = await deployment(t, { domain: '124.70.184.136', ipConfig: false });
  assert.notEqual(result.status, 0);
  assert.ok(!result.commands.includes('docker compose '));
});

test('Caddy validation failures stop publication and collect web and API logs', { skip: !bashAvailable }, async t => {
  const result = await deployment(t, { validationFails: true });
  assert.notEqual(result.status, 0);
  assert.ok(result.commands.includes('logs --tail=50 web api'));
  assert.ok(!result.commands.includes('curl\n'));
  assert.ok(!result.commands.includes('server/publish-release.js'));
});

for (const health of ['failed', 'redirect']) {
  test(`HTTPS ${health === 'failed' ? 'failures' : 'redirects'} exhaust bounded retries without publishing an APK`, { skip: !bashAvailable }, async t => {
    const result = await deployment(t, { health });
    assert.notEqual(result.status, 0);
    assert.equal(result.commands.split('\n').filter(line => line === 'curl').length, 12);
    assert.equal(result.commands.split('\n').filter(line => line === 'sleep').length, 11);
    assert.ok(result.commands.includes('logs --tail=50 web api'));
    assert.ok(!result.commands.includes('server/publish-release.js'));
  });
}

test('temporary HTTPS failures recover before an APK is published', { skip: !bashAvailable }, async t => {
  const result = await deployment(t, { health: 'transient' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.commands.split('\n').filter(line => line === 'curl').length, 3);
  assert.equal(result.commands.split('\n').filter(line => line === 'sleep').length, 2);
  assert.ok(result.commands.lastIndexOf('curl\n') < result.commands.indexOf('server/publish-release.js'));
});

test('the workflow deployment archive builds its Docker frontend without an Android project or preexisting files', { skip: !bashAvailable }, async t => {
  const directory = await fixture(t);
  for (const name of ['server', 'src', 'deploy', 'Dockerfile', 'compose.yaml', 'package.json', 'package-lock.json', 'capacitor.config.json', 'index.html', 'vite.config.js', '.dockerignore']) {
    await cp(join(root, name), join(directory, name), { recursive: true });
  }
  await mkdir(join(directory, 'output_apk'));
  await writeFile(join(directory, 'output_apk/hairstudio-member-v1.0.1.apk'), 'test-apk');
  await writeFile(join(directory, 'output_apk/update-manifest.json'), '{}');
  await writeFile(join(directory, '.env'), 'PRIVATE_TEST_VALUE=must-not-enter-the-archive\n');
  const lines = (await readFile(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n').split('\n');
  const step = lines.findIndex(line => line.includes('11. 打包生成服务器更新包'));
  const start = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  assert.ok(step >= 0 && start > step);
  const script = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index] && !lines[index].startsWith('        ')) break;
    script.push(lines[index].slice(8));
  }
  const packaged = run('set -e\n' + script.join('\n'), directory, { VERSION_NAME: '1.0.1' });
  assert.equal(packaged.status, 0, packaged.stdout + packaged.stderr);
  const unpacked = join(directory, 'unpacked');
  await mkdir(unpacked);
  const extracted = run('tar -xzf output_apk/server-update-v1.0.1.tar.gz -C unpacked', directory);
  assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr);
  await assert.rejects(access(join(unpacked, '.env')));
  await assert.rejects(access(join(unpacked, 'android')));
  await access(join(unpacked, '.dockerignore'));
  await symlink(join(root, 'node_modules'), join(unpacked, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  // Execute the actual frontend build instruction shipped in the Dockerfile.
  const dockerfile = await readFile(join(unpacked, 'Dockerfile'), 'utf8');
  const buildCommand = /^RUN (npm run build(?::web)?)$/m.exec(dockerfile)?.[1];
  assert.ok(buildCommand, 'Missing Docker frontend build instruction');
  const built = run(buildCommand, unpacked);
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const html = await readFile(join(unpacked, 'dist/index.html'), 'utf8');
  assert.match(html, /<script[^>]+src="\/assets\//);
});
