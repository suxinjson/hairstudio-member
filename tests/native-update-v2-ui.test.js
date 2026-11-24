import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { vueUi } from './helpers/vue-ui.mjs';

const origin = 'https://test.example';
const manifest = { versionName: '1.0.70', versionCode: 70, sha256: 'a'.repeat(64), notes: '隔离测试版本' };
const file = { fileName: manifest.sha256 + '.apk', verified: true };
let ui, component, ref, h, fixture;

before(async t => {
  ui = await vueUi(t);
  ({ ref, h } = await import('vue'));
  component = await ui.component(new URL('../src/components/NativeUpdate.vue', import.meta.url));
});
beforeEach(t => {
  localStorage.clear();
  fixture = {
    installedBuild: 69,
    check: t.mock.fn(async () => manifest),
    allow: t.mock.fn(async () => {}),
    api: {
      installedBuild: async () => fixture.installedBuild,
      download: t.mock.fn(async (_manifest, progress) => { progress(100); return file; }),
      install: t.mock.fn(async () => ({ status: 'installer-opened' })),
    },
  };
});
afterEach(() => ui.unmount());

async function flush() { await new Promise(resolve => setImmediate(resolve)); await ui.nextTick(); }
const button = label => ui.button(label);
const content = () => document.querySelector('#app').textContent;
const count = name => fixture.api[name].mock.callCount();
async function show({ available = manifest, server = origin, autoStart = false } = {}) {
  const token = ref(0), update = ref(available);
  const props = { api: fixture.api, origin: server, canCheck: true, checkUpdate: fixture.check, beforeInstall: fixture.allow };
  await ui.mount({ setup: () => () => h(component, { ...props, availableUpdate: update.value,
    autoStartDownload: autoStart, updateResumeToken: token.value }) });
  await flush();
  return {
    async resume() { token.value++; await flush(); },
    async publish(value) { update.value = value; await flush(); },
  };
}

test('the v2 update notice downloads the verified package and opens the installer without checking again', async () => {
  await show({ autoStart: true });
  assert.equal(fixture.check.mock.callCount(), 0);
  assert.equal(count('download'), 1);
  assert.deepEqual(fixture.api.install.mock.calls[0].arguments, [file, manifest]);
  assert.match(content(), /已打开系统安装界面/);
});

test('remount and return from an incomplete install reuse the file, then a completed install clears it', async () => {
  await show();
  button('下载并安装更新').click(); await flush();
  assert.equal(count('install'), 1);
  const screen = await show();
  assert.equal(count('install'), 2);
  await screen.resume();
  assert.equal(count('download'), 1);
  assert.equal(count('install'), 3);
  fixture.installedBuild = 70; await screen.resume();
  assert.equal(count('install'), 3);
  assert.match(content(), /更新已完成/);
  assert.equal(localStorage.getItem('member.pending-update-install.v2'), null);
});

test('another server origin cannot reuse a cached installer', async () => {
  await show();
  button('下载并安装更新').click(); await flush();
  assert.equal(count('install'), 1);
  await show({ server: 'https://other.test.example' });
  assert.equal(count('install'), 1);
  assert.equal(button('下载并安装更新').disabled, false);
});

test('the shared checker can withdraw a previously available and downloaded release', async () => {
  fixture.api.install.mock.mockImplementation(async () => ({ status: 'permission-required' }));
  const screen = await show();
  button('下载并安装更新').click(); await flush();
  await screen.publish(null);
  assert.doesNotMatch(content(), /新版本|继续安装更新/);
  assert.equal(localStorage.getItem('member.pending-update-install.v2'), null);
});

test('double clicks use one installer and a permission denial permits retry with the same package', async () => {
  let finish;
  fixture.api.install.mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const screen = await show();
  const download = button('下载并安装更新'); download.click(); download.click(); await flush();
  assert.equal(count('download'), 1);
  assert.equal(count('install'), 1);
  assert.equal(button('继续安装更新').disabled, true);
  finish({ status: 'permission-required' }); await flush();
  await screen.resume(); assert.equal(count('install'), 1);
  button('继续安装更新').click(); await flush();
  assert.equal(count('download'), 1);
  assert.equal(count('install'), 2);
});

test('unknown ledger results block download and failed package verification blocks the installer', async () => {
  fixture.allow.mock.mockImplementationOnce(async () => { throw new Error('请先核对原待办'); });
  fixture.api.download.mock.mockImplementationOnce(async () => { throw new Error('安装包完整性校验失败'); });
  await show();
  button('下载并安装更新').click(); await flush();
  assert.equal(count('download'), 0);
  assert.match(content(), /请先核对原待办/);
  button('下载并安装更新').click(); await flush();
  assert.equal(count('install'), 0);
  assert.match(content(), /安装包完整性校验失败/);
  button('下载并安装更新').click(); await flush();
  assert.equal(count('download'), 2);
  assert.equal(count('install'), 1);
});

test('a late update check from a closed account page cannot overwrite the new page', async () => {
  let finish;
  fixture.check.mock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await show({ available: null });
  button('检查更新').click(); await flush();
  await show({ server: 'https://other.test.example', available: { ...manifest, versionCode: 71, versionName: '1.0.71' } });
  finish(manifest); await flush();
  assert.match(content(), /1\.0\.71/);
  assert.doesNotMatch(content(), /1\.0\.70/);
});
