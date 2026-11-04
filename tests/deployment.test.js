import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bashAvailable = spawnSync(bash, ['--version'], { encoding: 'utf8' }).status === 0;
const flockAvailable = bashAvailable && spawnSync(bash, ['--noprofile', '--norc', '-c', 'command -v flock'], { encoding: 'utf8' }).status === 0;
const unix = path => path.replaceAll('\\', '/');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'member-deployment-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    writeFile(join(directory, 'releases/update-manifest.json'), JSON.stringify({ versionName: '1.0.1' }, null, 2)),
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
    writeFile(join(bin, 'sleep'), '#!/usr/bin/env bash\nprintf "sleep\\n" >> "$REVIEW_LOG"\n', { mode: 0o755 }),
    writeFile(join(bin, 'flock'), '#!/usr/bin/env bash\nprintf "flock %s\\n" "$*" >> "$REVIEW_LOG"\n', { mode: 0o755 })
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

function shellPath(path) { return process.platform === 'win32' ? unix(path).replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()) : path; }

async function installation(t, { realLock = false } = {}) {
  const directory = await fixture(t), target = join(directory, 'target with spaces'), bin = join(directory, 'bin');
  await mkdir(target); await mkdir(bin);
  await writeFile(join(target, '.env'), 'PRIVATE_VALUE=retained\n');
  if (!realLock) await writeFile(join(bin, 'flock'), '#!/usr/bin/env bash\nprintf "lock\\n" >> "$REVIEW_LOG"\n', { mode: 0o755 });
  const env = { REVIEW_INSTALLER: shellPath(join(root, 'deploy/install-update.sh')), REVIEW_TARGET: shellPath(target),
    REVIEW_LOG: shellPath(join(directory, 'install.log')), REVIEW_BIN: shellPath(bin) };
  async function bundle(version, manifestVersion = version) {
    const payload = join(directory, 'payload-' + version), archive = join(directory, 'bundle-' + version + '.tar.gz');
    await mkdir(join(payload, 'deploy'), { recursive: true }); await mkdir(join(payload, 'releases'));
    await writeFile(join(payload, 'release-version.txt'), String(version) + '\n');
    await writeFile(join(payload, 'source.txt'), 'source-' + version);
    await writeFile(join(payload, 'releases/update-manifest.json'), JSON.stringify({ versionCode: manifestVersion, versionName: '1.0.' + manifestVersion }, null, 2));
    await writeFile(join(payload, 'deploy/deploy-update.sh'), '#!/usr/bin/env bash\nversion=$(cat release-version.txt)\nprintf "deploy-%s\\n" "$version" >> "$REVIEW_LOG"\nsleep "${REVIEW_DELAY:-0}"\nprintf "finished-%s-%s\\n" "$version" "$(cat release-version.txt)" >> "$REVIEW_LOG"\n');
    const result = run('tar -czf "$REVIEW_BUNDLE" -C "$REVIEW_PAYLOAD" .', directory, { REVIEW_BUNDLE: shellPath(archive), REVIEW_PAYLOAD: shellPath(payload) });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return shellPath(archive);
  }
  const script = 'export PATH="$REVIEW_BIN:$PATH"\nbash "$REVIEW_INSTALLER" "$REVIEW_TARGET" "$REVIEW_BUNDLE"';
  return { directory, target, env, script, bundle };
}

test('installation rejects stale archives before replacing code and permits the same version to retry', { skip: !bashAvailable }, async t => {
  const setup = await installation(t);
  const newest = await setup.bundle(3), stale = await setup.bundle(2);
  const first = run(setup.script, setup.directory, { ...setup.env, REVIEW_BUNDLE: newest });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const older = run(setup.script, setup.directory, { ...setup.env, REVIEW_BUNDLE: stale });
  assert.equal(older.status, 0, older.stdout + older.stderr);
  assert.match(older.stdout, /Skipping stale deployment/);
  assert.equal(await readFile(join(setup.target, 'source.txt'), 'utf8'), 'source-3');
  assert.equal(await readFile(join(setup.target, '.env'), 'utf8'), 'PRIVATE_VALUE=retained\n');
  assert.equal((await readFile(join(setup.target, '.member-deployment-version'), 'utf8')).trim(), '3');
  const retry = run(setup.script, setup.directory, { ...setup.env, REVIEW_BUNDLE: newest });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal((await readFile(join(setup.directory, 'install.log'), 'utf8')).split('\n').filter(line => line === 'deploy-3').length, 2);
});

test('a legacy installed manifest also prevents rollback, and inconsistent archive metadata cannot replace code', { skip: !bashAvailable }, async t => {
  const setup = await installation(t);
  await mkdir(join(setup.target, 'releases'));
  await writeFile(join(setup.target, 'releases/update-manifest.json'), JSON.stringify({ versionCode: 5 }, null, 2));
  await writeFile(join(setup.target, 'source.txt'), 'existing');
  const stale = await setup.bundle(4), inconsistent = await setup.bundle(6, 7);
  assert.equal(run(setup.script, setup.directory, { ...setup.env, REVIEW_BUNDLE: stale }).status, 0);
  const bad = run(setup.script, setup.directory, { ...setup.env, REVIEW_BUNDLE: inconsistent });
  assert.notEqual(bad.status, 0);
  assert.equal(await readFile(join(setup.target, 'source.txt'), 'utf8'), 'existing');
  await assert.rejects(access(join(setup.target, '.member-deployment-version')));
});

test('concurrent installations use separate archives and serialize the entire deployment under flock', { skip: !flockAvailable }, async t => {
  const setup = await installation(t, { realLock: true });
  const older = await setup.bundle(10), newer = await setup.bundle(11);
  const start = (archive, delay) => {
    const child = spawn(bash, ['--noprofile', '--norc', '-c', setup.script], { cwd: setup.directory,
      env: { ...process.env, ...setup.env, REVIEW_BUNDLE: archive, REVIEW_DELAY: delay }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, output })); });
  };
  const first = start(older, '0.5');
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readFile(join(setup.directory, 'install.log'), 'utf8').catch(() => '')).includes('deploy-10')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const second = start(newer, '0');
  for (const result of await Promise.all([first, second])) assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(join(setup.target, 'source.txt'), 'utf8'), 'source-11');
  assert.deepEqual((await readFile(join(setup.directory, 'install.log'), 'utf8')).trim().split('\n'), ['deploy-10', 'finished-10-10', 'deploy-11', 'finished-11-11']);
});

test('SSH deployment requires a matching pinned host and uses strict checking with distinct run paths', { skip: !bashAvailable }, async t => {
  const directory = await fixture(t), bin = join(directory, 'bin'); await mkdir(bin);
  for (const command of ['ssh', 'scp']) await writeFile(join(bin, command), '#!/usr/bin/env bash\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$REVIEW_LOG"\n', { mode: 0o755 });
  const lines = (await readFile(join(root, '.github/workflows/build-apk.yml'), 'utf8')).replaceAll('\r\n', '\n').split('\n');
  const step = lines.findIndex(line => line.includes('13. [方案B]'));
  const start = lines.findIndex((line, index) => index > step && line.trim() === 'run: |');
  const script = [];
  for (let index = start + 1; index < lines.length; index++) { if (lines[index] && !lines[index].startsWith('        ')) break; script.push(lines[index].slice(8)); }
  const env = { REVIEW_BIN: shellPath(bin), REVIEW_LOG: shellPath(join(directory, 'ssh.log')), RUNNER_TEMP: shellPath(directory),
    SERVER_HOST: 'member.example.com', SERVER_USER: 'ubuntu', SERVER_PORT: '2222', SERVER_DEPLOY_PATH: '~/member with spaces',
    SERVER_SSH_KEY: 'fixture key', SERVER_KNOWN_HOSTS: '', GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', VERSION_NAME: '1.0.1' };
  const command = 'export PATH="$REVIEW_BIN:$PATH"\n' + script.join('\n');
  const missing = run(command, directory, env);
  assert.notEqual(missing.status, 0); assert.match(missing.stdout, /Missing SERVER_KNOWN_HOSTS/);
  await assert.rejects(access(join(directory, 'ssh.log')));
  const wrongHost = run(command, directory, { ...env, SERVER_KNOWN_HOSTS: 'other.example.com ssh-ed25519 AAAA' });
  assert.notEqual(wrongHost.status, 0); await assert.rejects(access(join(directory, 'ssh.log')));
  const pinned = { ...env, SERVER_KNOWN_HOSTS: '[member.example.com]:2222 ssh-ed25519 AAAA' };
  for (const attempt of ['1', '2']) {
    const result = run(command, directory, { ...pinned, GITHUB_RUN_ATTEMPT: attempt });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const calls = await readFile(join(directory, 'ssh.log'), 'utf8');
  assert.ok(!calls.includes('StrictHostKeyChecking=no')); assert.ok(!calls.includes('UserKnownHostsFile=/dev/null'));
  assert.ok(calls.split('\n').filter(Boolean).every(line => line.includes('StrictHostKeyChecking=yes')));
  assert.match(calls, /member-update-100-1\.tar\.gz/); assert.match(calls, /member-update-100-2\.tar\.gz/);
  assert.ok(!calls.includes('eval echo'));
  await mkdir(join(directory, 'deploy'));
  await writeFile(join(directory, 'deploy/ssh_known_hosts'), '124.70.184.136 ssh-ed25519 AAAA\n');
  const missingDefault = run(command, directory, { ...env, SERVER_HOST: '124.70.184.136', SERVER_PORT: '22' });
  assert.notEqual(missingDefault.status, 0);
  assert.match(missingDefault.stdout, /Missing SERVER_KNOWN_HOSTS/);
  assert.equal(await readFile(join(directory, 'ssh.log'), 'utf8'), calls);
  const defaultSecret = { ...env, SERVER_HOST: '124.70.184.136', SERVER_PORT: '22',
    SERVER_KNOWN_HOSTS: '124.70.184.136 ssh-ed25519 AAAA', GITHUB_RUN_ATTEMPT: '3' };
  const configured = run(command, directory, defaultSecret);
  assert.equal(configured.status, 0, configured.stdout + configured.stderr);
  assert.equal(await readFile(join(directory, 'member-deploy-known-hosts'), 'utf8'), defaultSecret.SERVER_KNOWN_HOSTS + '\n');
  const beforeRejected = await readFile(join(directory, 'ssh.log'), 'utf8');
  const customServer = run(command, directory, env);
  assert.notEqual(customServer.status, 0);
  assert.match(customServer.stdout, /Missing SERVER_KNOWN_HOSTS/);
  assert.equal(await readFile(join(directory, 'ssh.log'), 'utf8'), beforeRejected);
  const badOverride = run(command, directory, { ...env, SERVER_HOST: '124.70.184.136', SERVER_PORT: '22', SERVER_KNOWN_HOSTS: 'other.example.com ssh-ed25519 AAAA' });
  assert.notEqual(badOverride.status, 0);
  assert.equal(await readFile(join(directory, 'ssh.log'), 'utf8'), beforeRejected);
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
  const packaged = run('set -e\n' + script.join('\n'), directory, { VERSION_NAME: '1.0.1', VERSION_CODE: '1' });
  assert.equal(packaged.status, 0, packaged.stdout + packaged.stderr);
  const unpacked = join(directory, 'unpacked');
  await mkdir(unpacked);
  const extracted = run('tar -xzf output_apk/server-update-v1.0.1.tar.gz -C unpacked', directory);
  assert.equal(extracted.status, 0, extracted.stdout + extracted.stderr);
  await assert.rejects(access(join(unpacked, '.env')));
  await assert.rejects(access(join(unpacked, 'android')));
  await access(join(unpacked, '.dockerignore'));
  assert.equal((await readFile(join(unpacked, 'release-version.txt'), 'utf8')).trim(), '1');
  await access(join(unpacked, 'deploy/install-update.sh'));
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
