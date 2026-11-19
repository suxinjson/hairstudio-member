import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key];
globalThis.localStorage = dom.window.localStorage;
const require = createRequire(import.meta.url);
const { parse, compileScript } = await import('@vue/compiler-sfc');
const vueUrl = pathToFileURL(require.resolve('vue')).href;
const { createApp, nextTick, ref, h } = await import(vueUrl);
const { Capacitor } = await import('@capacitor/core');
const directory = await mkdtemp(join(tmpdir(), 'member-update-ui-'));
const apiPath = join(directory, 'update-api.mjs');
const nativeAppPath = join(directory, 'native-app.mjs');
await writeFile(nativeAppPath, 'export const App = { getInfo: (...args) => globalThis.updateFixture.getInfo(...args) };');
await writeFile(apiPath, `
export const cloudClient = {
  snapshot: () => globalThis.updateFixture.state,
  subscribe: callback => { callback(globalThis.updateFixture.state); return () => {}; },
  sync: () => globalThis.updateFixture.sync()
};
export const checkForUpdate = () => globalThis.updateFixture.check();
export const downloadUpdate = (...args) => globalThis.updateFixture.download(...args);
export const installUpdate = (...args) => globalThis.updateFixture.install(...args);
export const copyToClipboard = async () => {};
`);
const sourceUrl = new URL('../src/components/CloudSettings.vue', import.meta.url);
const { descriptor } = parse(await readFile(sourceUrl, 'utf8'));
let script = compileScript(descriptor, { id: 'update-ui', inlineTemplate: true }).content;
for (const [full, quote, specifier] of [...script.matchAll(/from (['"])([^'"]+)\1/g)]) {
  const target = specifier === 'vue' ? vueUrl
    : specifier === '@capacitor/app' ? pathToFileURL(nativeAppPath).href
    : specifier === '../cloud-device.js' ? pathToFileURL(apiPath).href
    : specifier.startsWith('.') ? new URL(specifier, sourceUrl).href
    : pathToFileURL(require.resolve(specifier)).href;
  script = script.replace(full, `from ${quote}${target}${quote}`);
}
const componentPath = join(directory, 'settings.mjs');
await writeFile(componentPath, script);
const { default: CloudSettings } = await import(pathToFileURL(componentPath).href);

let app, fixture;
const manifest = { versionName: '1.0.70', versionCode: 70, sha256: 'a'.repeat(64), notes: '' };
const file = { fileName: 'a'.repeat(64) + '.apk', verified: true };
async function flush() { for (let i = 0; i < 20; i++) await nextTick(); }
const button = text => [...document.querySelectorAll('button')].find(value => value.textContent.trim() === text);
beforeEach(t => {
  t.mock.method(Capacitor, 'isNativePlatform', () => true);
  localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  fixture = globalThis.updateFixture = {
    state: { user: { role: 'owner' }, online: true, outbox: [], status: 'synced' },
    installedBuild: '69',
    getInfo: t.mock.fn(async () => ({ build: fixture.installedBuild })),
    sync: t.mock.fn(async () => {}),
    check: t.mock.fn(async () => manifest),
    download: t.mock.fn(async (_manifest, progress) => { progress(100); return file; }),
    install: t.mock.fn(async () => ({ status: 'installer-opened' }))
  };
});
afterEach(() => { app?.unmount(); app = null; delete globalThis.updateFixture; });
after(async () => { dom.window.close(); await rm(directory, { recursive: true, force: true }); });
async function showUpdate() {
  app = createApp(CloudSettings, { section: 'update' });
  app.mount('#app'); await flush();
  button('检查更新').click(); await flush();
}
async function showUpdateWithResumeToken() {
  const token = ref(0);
  app = createApp({ setup: () => () => h(CloudSettings, { section: 'update', availableUpdate: manifest, updateResumeToken: token.value }) });
  app.mount('#app'); await flush();
  return async () => { token.value++; await flush(); };
}

test('native update opens the installer after download with one click and passes the verified file', async () => {
  await showUpdate();
  button('下载并安装更新').click(); await flush();
  assert.equal(fixture.sync.mock.callCount(), 1);
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 1);
  assert.deepEqual(fixture.install.mock.calls[0].arguments, [file, manifest]);
  assert.ok(document.body.textContent.includes('已打开系统安装界面'));
});

test('a version discovered on startup is ready to download without a second manual check', async () => {
  app = createApp(CloudSettings, { section: 'update', availableUpdate: manifest });
  app.mount('#app'); await flush();
  assert.ok(document.body.textContent.includes('新版本 1.0.70'));
  assert.equal(fixture.check.mock.callCount(), 0);
  button('下载并安装更新').click(); await flush();
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 1);
});

test('following the update notice starts download and installation without another check or tap', async () => {
  app = createApp(CloudSettings, { section: 'update', availableUpdate: manifest, autoStartDownload: true });
  app.mount('#app'); await flush();
  assert.equal(fixture.check.mock.callCount(), 0);
  assert.equal(fixture.sync.mock.callCount(), 1);
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 1);
});

test('a saved verified APK survives remount and continues without downloading again', async () => {
  localStorage.setItem('member.pending-update-install.v1', JSON.stringify({ fileName: file.fileName,
    sha256: manifest.sha256, versionCode: manifest.versionCode, versionName: manifest.versionName, notes: '' }));
  app = createApp(CloudSettings, { section: 'update', availableUpdate: manifest });
  app.mount('#app'); await flush();
  assert.ok(button('继续安装更新'));
  assert.equal(fixture.download.mock.callCount(), 0);
  button('继续安装更新').click(); await flush();
  assert.equal(fixture.download.mock.callCount(), 0);
  assert.equal(fixture.install.mock.callCount(), 1);
});

test('choosing update again reopens the saved APK instead of downloading another copy', async () => {
  localStorage.setItem('member.pending-update-install.v1', JSON.stringify({ fileName: file.fileName,
    sha256: manifest.sha256, versionCode: manifest.versionCode, manifest, awaitingInstall: true }));
  app = createApp(CloudSettings, { section: 'update', availableUpdate: manifest, autoStartDownload: true });
  app.mount('#app'); await flush();
  assert.equal(fixture.sync.mock.callCount(), 0);
  assert.equal(fixture.download.mock.callCount(), 0);
  assert.equal(fixture.install.mock.callCount(), 1);
});

test('choosing update after it was already installed clears the saved APK without reopening it', async () => {
  fixture.installedBuild = '70';
  localStorage.setItem('member.pending-update-install.v1', JSON.stringify({ fileName: file.fileName,
    sha256: manifest.sha256, versionCode: manifest.versionCode, manifest, awaitingInstall: true }));
  app = createApp(CloudSettings, { section: 'update', availableUpdate: manifest, autoStartDownload: true });
  app.mount('#app'); await flush();
  assert.equal(fixture.install.mock.callCount(), 0);
  assert.equal(fixture.download.mock.callCount(), 0);
  assert.equal(localStorage.getItem('member.pending-update-install.v1'), null);
  assert.ok(document.body.textContent.includes('更新已完成'));
});

test('returning from an incomplete installation reopens the cached APK without downloading again', async () => {
  const resume = await showUpdateWithResumeToken();
  button('检查更新').click(); await flush();
  button('下载并安装更新').click(); await flush();
  assert.equal(fixture.install.mock.callCount(), 1);
  await resume();
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 2);
});

test('returning after installation confirms the installed version and does not reopen the APK', async () => {
  const resume = await showUpdateWithResumeToken();
  button('检查更新').click(); await flush();
  button('下载并安装更新').click(); await flush();
  fixture.installedBuild = '70';
  await resume();
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 1);
  assert.ok(document.body.textContent.includes('更新已完成'));
  assert.equal(button('继续安装更新'), undefined);
});

test('the update page removes a withdrawn version published by the shared checker', async () => {
  const { h, ref } = await import(vueUrl);
  const available = ref(manifest);
  app = createApp({ setup: () => () => h(CloudSettings, { section: 'update', availableUpdate: available.value }) });
  app.mount('#app'); await flush();
  assert.ok(button('下载并安装更新'));
  available.value = null; await flush();
  assert.equal(button('下载并安装更新'), undefined);
  assert.doesNotMatch(document.body.textContent, /新版本 1\.0\.70/);
});

for (const result of ['success', 'failure']) {
  test(`a manual ${result} after an account change cannot update the new account's page`, async () => {
    let finish;
    fixture.state.user.id = 'original-owner';
    fixture.check.mock.mockImplementation(() => new Promise((resolve, reject) => {
      finish = () => result === 'success' ? resolve(manifest) : reject(new Error('previous account check failed'));
    }));
    await showUpdate();
    fixture.state.user.id = 'another-owner';
    finish(); await flush();
    assert.equal(button('下载并安装更新'), undefined);
    assert.doesNotMatch(document.body.textContent, /新版本 1\.0\.70|previous account check failed/);
    assert.equal(button('检查更新').disabled, false);
  });
}

test('double clicks cannot download or open multiple installers while authorization is pending', async () => {
  let finish;
  fixture.install.mock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const resume = await showUpdateWithResumeToken();
  const download = button('下载并安装更新');
  download.click(); download.click(); await flush();
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 1);
  assert.equal(button('正在准备安装…').disabled, true);
  assert.equal(button('检查更新').disabled, true);
  button('正在准备安装…').click(); await flush();
  assert.equal(fixture.install.mock.callCount(), 1);
  finish({ status: 'permission-required' }); await flush();
  assert.equal(button('继续安装更新').disabled, false);
  await resume();
  assert.equal(fixture.install.mock.callCount(), 1);
});

test('denied permission and installer errors keep the downloaded APK available for retry', async () => {
  fixture.install.mock.mockImplementationOnce(async () => ({ status: 'permission-required' }), 0);
  fixture.install.mock.mockImplementationOnce(async () => { throw new Error('无法打开安装界面，请重试'); }, 1);
  await showUpdate();
  button('下载并安装更新').click(); await flush();
  assert.ok(document.body.textContent.includes('无需再次下载'));
  button('继续安装更新').click(); await flush();
  assert.ok(document.body.textContent.includes('无法打开安装界面，请重试'));
  assert.equal(button('继续安装更新').disabled, false);
  button('继续安装更新').click(); await flush();
  assert.equal(fixture.download.mock.callCount(), 1);
  assert.equal(fixture.install.mock.callCount(), 3);
  assert.ok(document.body.textContent.includes('已打开系统安装界面'));
});

test('failed APK verification never starts installation and allows another download', async () => {
  fixture.download.mock.mockImplementationOnce(async () => { throw new Error('安装包完整性校验失败，请重新下载'); });
  await showUpdate();
  button('下载并安装更新').click(); await flush();
  assert.equal(fixture.install.mock.callCount(), 0);
  assert.ok(document.body.textContent.includes('安装包完整性校验失败'));
  assert.equal(button('下载并安装更新').disabled, false);
  button('下载并安装更新').click(); await flush();
  assert.equal(fixture.install.mock.callCount(), 1);
});

test('unresolved ledger changes block download and installation', async () => {
  fixture.state.outbox = [{ id: 'pending' }];
  await showUpdate();
  button('下载并安装更新').click(); await flush();
  assert.equal(fixture.download.mock.callCount(), 0);
  assert.equal(fixture.install.mock.callCount(), 0);
  assert.ok(document.body.textContent.includes('请先同步或处理待办记录'));
});

test('web download leaves installation to the browser and never invokes the native installer', async t => {
  t.mock.method(Capacitor, 'isNativePlatform', () => false);
  fixture.download.mock.mockImplementation(async () => ({ browser: true, verified: true }));
  await showUpdate();
  button('下载并校验更新').click(); await flush();
  assert.equal(fixture.install.mock.callCount(), 0);
  assert.ok(document.body.textContent.includes('浏览器下载记录'));
  assert.equal(button('继续安装更新'), undefined);
});
