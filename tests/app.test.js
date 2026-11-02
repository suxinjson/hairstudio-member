import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'FileReader']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { parse, compileScript } = await import('@vue/compiler-sfc');
const require = createRequire(import.meta.url);
const vueUrl = pathToFileURL(require.resolve('vue')).href;
const directory = await mkdtemp(join(tmpdir(), 'member-ui-test-'));
const keypadPath = join(directory, 'keypad.mjs');
const cloudSettingsPath = join(directory, 'cloud-settings.mjs');
const nativeAppPath = join(directory, 'native-app.mjs');
await writeFile(nativeAppPath, 'export const App = { addListener() { throw new Error("Unexpected native subscription"); }, async exitApp() {} };');
const nativeAppUrl = pathToFileURL(nativeAppPath).href;
const { App: nativeApp } = await import(nativeAppUrl);
const { Capacitor } = await import('@capacitor/core');

async function compileComponent(sourceUrl, outputPath, keypadUrl) {
  const source = await readFile(sourceUrl, 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: outputPath, inlineTemplate: true }).content;
  const rewritten = script.replace(/from (['"])([^'"]+)\1/g, (match, quote, specifier) => {
    const target = specifier === 'vue' ? vueUrl
      : specifier === '@capacitor/app' ? nativeAppUrl
      : specifier.endsWith('Keypad.vue') ? keypadUrl
      : specifier.endsWith('CloudSettings.vue') ? pathToFileURL(cloudSettingsPath).href
      : specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : pathToFileURL(require.resolve(specifier)).href;
    return `from ${quote}${target}${quote}`;
  });
  await writeFile(outputPath, rewritten);
}
await compileComponent(new URL('../src/components/Keypad.vue', import.meta.url), keypadPath);
await compileComponent(new URL('../src/components/CloudSettings.vue', import.meta.url), cloudSettingsPath);
const appPath = join(directory, 'app.mjs');
await compileComponent(new URL('../src/App.vue', import.meta.url), appPath, pathToFileURL(keypadPath).href);
const { default: App } = await import(pathToFileURL(appPath).href);
const { createApp, nextTick } = await import(vueUrl);
const { localDb } = await import('../src/storage.js');
const { saveCloudState, getCloudState } = await import('../src/cloud-storage.js');
const { cloudClient } = await import('../src/cloud-device.js');

class MemoryStorage {
  values = new Map();
  failKey = null;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (key === this.failKey) throw new Error('quota exceeded');
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

let app;
beforeEach(() => {
  Capacitor.isNativePlatform = () => true;
  globalThis.localStorage = new MemoryStorage();
  document.body.innerHTML = '<div id="app"></div>';
  window.scrollTo = () => {};
  localDb.init();
});
afterEach(() => app?.unmount());
after(async () => {
  dom.window.close();
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unexpected temporary directory');
  await rm(directory, { recursive: true });
});

async function mount() {
  app = createApp(App);
  app.mount('#app');
  await nextTick();
}
function button(text) {
  const match = [...document.querySelectorAll('button')].find(element => element.textContent.includes(text));
  assert.ok(match, `Missing button: ${text}`);
  return match;
}
async function settings(page = 'overview') {
  [...document.querySelectorAll('nav button')].find(element => element.textContent.includes('设置')).click();
  await nextTick();
  const titles = { account: '账号与同步', services: '服务与价格', 'backup-files': '导出与恢复', snapshots: '本地快照' };
  if (['backup-files', 'snapshots'].includes(page)) { button('数据备份').click(); await nextTick(); }
  if (page !== 'overview') { button(titles[page] || page).click(); await nextTick(); }
}
async function selectBackup(content) {
  if (!document.querySelector('input[type="file"]')) await settings('backup-files');
  const input = document.querySelector('input[type="file"]');
  assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new dom.window.File([content], 'backup.json', { type: 'application/json' })] });
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 30));
  await nextTick();
}

test('damaged storage keeps the backup restore screen available and permits validated replacement', async t => {
  t.mock.method(console, 'error', () => {});
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const content = localDb.exportBackupData({ archiveSnapshot: false });
  localStorage.setItem('hairstudio_members_v2', '{broken');
  await mount();
  assert.ok(document.body.textContent.includes('当前账本无法读取'));
  await selectBackup(content);
  assert.ok(document.body.textContent.includes('读取异常，无法统计'));
  assert.equal(document.querySelector('input[value="merge"]').disabled, true);
  assert.equal(document.querySelector('input[value="replace"]').checked, true);
  assert.equal(button('确认完全覆盖').disabled, false);
  button('确认完全覆盖').click();
  await nextTick();
  assert.equal(localDb.getMembers().length, 1);
  assert.equal(localDb.getMembers()[0].balance, 10000);
  assert.equal(document.body.textContent.includes('当前账本无法读取'), false);
  assert.ok(document.body.textContent.includes('全量恢复完成'));
});

test('a failed manual snapshot displays failure instead of success', async t => {
  t.mock.method(console, 'warn', () => {});
  await mount();
  await settings('snapshots');
  localStorage.failKey = 'hairstudio_local_snapshots_v1';
  button('立即归档').click();
  await nextTick();
  assert.ok(document.body.textContent.includes('归档失败'));
  assert.equal(document.body.textContent.includes('已在手机本地生成一份最新账本快照'), false);
  assert.equal(localDb.getLocalSnapshots().length, 0);
});

test('external export succeeds with an explicit warning when its optional local snapshot fails', async t => {
  Capacitor.isNativePlatform = () => false;
  cloudProfile('owner', t);
  t.mock.method(console, 'warn', () => {});
  const received = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: async request => { received.push(request.files[0]); }, configurable: true });
  t.after(() => { delete navigator.canShare; delete navigator.share; });
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  await settings('backup-files');
  localStorage.failKey = 'hairstudio_local_snapshots_v1';
  button('一键备份所有账本').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  await nextTick();
  assert.equal(received.length, 1);
  const exported = JSON.parse(await received[0].text());
  assert.equal(exported.data.members[0].balance, 10000);
  assert.ok(document.body.textContent.includes('本地快照未保存'));
  assert.equal(document.body.textContent.includes('备份导出失败'), false);
});

test('the recharge form accepts decimals and credits the exact confirmed total', async () => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111' });
  await mount();
  button('会员充值').click();
  await nextTick();
  const inputs = [...document.querySelectorAll('input[type="number"]')];
  inputs[0].value = '19.99';
  inputs[1].value = '0.07';
  inputs.forEach(input => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
  await nextTick();
  assert.equal(button('核对充值信息').disabled, false);
  button('核对充值信息').click();
  await nextTick();
  button('确认充值').click();
  await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 2006);
});

test('conflicting backup disables merge but still permits canceling the preview', async () => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const base = localDb.exportBackupData({ archiveSnapshot: false });
  localDb.consume({ memberId: member.id, amount: 38 });
  const branch = localDb.exportBackupData({ archiveSnapshot: false });
  localDb.importBackupData(base);
  localDb.recharge({ memberId: member.id, actualPay: 50 });
  await mount();
  await settings();
  await selectBackup(branch);
  assert.equal(button('确认增量合并').disabled, true);
  assert.equal(button('取消').disabled, false);
  button('取消').click();
  await nextTick();
  assert.equal(document.querySelector('#restore-confirm-title'), null);
  assert.equal(localDb.getMemberById(member.id).balance, 15000);
});

test('whitespace-only phone edits cannot be saved through the member form', async () => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const previous = new Map(localStorage.values);
  await mount();
  document.querySelector('.member-card > div').click();
  await nextTick();
  button('修改档案').click();
  await nextTick();
  const phone = document.querySelector('input[type="tel"]');
  phone.value = '   ';
  phone.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await nextTick();
  assert.equal(button('保存档案').disabled, true);
  button('保存档案').click();
  assert.deepEqual(localStorage.values, previous);
  phone.value = '13900001111';
  phone.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await nextTick();
  button('保存档案').click();
  await nextTick();
  assert.equal(localDb.getMemberById(member.id).phone, '13900001111');
  assert.equal(document.body.textContent.includes('当前账本无法读取'), false);
});

test('a numeric ledger phone is rejected by the import screen and the current ledger stays usable', async () => {
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const invalid = JSON.parse(localDb.exportBackupData({ archiveSnapshot: false }));
  invalid.data.ledgers[0].memberPhone = 13800001111;
  const previous = new Map(localStorage.values);
  await mount();
  await settings();
  await selectBackup(JSON.stringify(invalid));
  assert.ok(document.body.textContent.includes('备份校验失败'));
  assert.equal(document.querySelector('#restore-confirm-title'), null);
  assert.deepEqual(localStorage.values, previous);
  button('知道了').click();
  await nextTick();
  document.querySelectorAll('nav button')[2].click();
  await nextTick();
  assert.ok(document.body.textContent.includes('138 0000 1111'));
});

function assertDailySummary(date, recharge) {
  assert.ok(document.querySelector('header').textContent.includes(date));
  const rechargeCard = document.querySelector('.dashboard-card .grid > div');
  assert.match(rechargeCard.textContent, new RegExp(`¥\\s*${recharge.replace('.', '\\.')}\\b`));
}

test('midnight refreshes the date and today totals without a transaction, and stops on unmount', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 10, 2, 23, 59, 59) });
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  assertDailySummary('11月2日', '100.00');
  t.mock.timers.tick(1000);
  await nextTick();
  assertDailySummary('11月3日', '0.00');
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await nextTick();
  assertDailySummary('11月4日', '0.00');
  const dashboardRead = t.mock.method(localDb, 'getDashboard');
  app.unmount();
  app = null;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(dashboardRead.mock.callCount(), 0);
});

for (const event of ['focus', 'visibilitychange']) {
  test(`${event} refreshes stale date and totals on returning to the foreground`, async t => {
    const day = new Date(2026, 10, 2, 12);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: day });
    localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
    await mount();
    assertDailySummary('11月2日', '100.00');
    t.mock.timers.setTime(new Date(2026, 10, 3, 12).getTime());
    const target = event === 'focus' ? window : document;
    if (event === 'visibilitychange') {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      t.after(() => { delete document.visibilityState; });
    }
    target.dispatchEvent(new dom.window.Event(event));
    await nextTick();
    assertDailySummary('11月3日', '0.00');
    const dashboardRead = t.mock.method(localDb, 'getDashboard');
    app.unmount();
    app = null;
    target.dispatchEvent(new dom.window.Event(event));
    assert.equal(dashboardRead.mock.callCount(), 0);
  });
}

test('native app activation refreshes daily totals and removes its listener on unmount', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 10, 2, 12) });
  t.mock.method(Capacitor, 'isNativePlatform', () => true);
  let onAppStateChange;
  const remove = t.mock.fn(async () => {});
  const removeBack = t.mock.fn(async () => {});
  t.mock.method(nativeApp, 'addListener', async (event, listener) => {
    if (event === 'appStateChange') { onAppStateChange = listener; return { remove }; }
    assert.equal(event, 'backButton');
    return { remove: removeBack };
  });
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  assertDailySummary('11月2日', '100.00');
  t.mock.timers.setTime(new Date(2026, 10, 3, 12).getTime());
  onAppStateChange({ isActive: false });
  await nextTick();
  assertDailySummary('11月2日', '100.00');
  onAppStateChange({ isActive: true });
  await nextTick();
  assertDailySummary('11月3日', '0.00');
  app.unmount();
  app = null;
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(removeBack.mock.callCount(), 1);
});

test('a native listener that finishes registering after unmount is removed immediately', async t => {
  t.mock.method(Capacitor, 'isNativePlatform', () => true);
  let completeRegistration;
  const remove = t.mock.fn(async () => {});
  const removeBack = t.mock.fn(async () => {});
  t.mock.method(nativeApp, 'addListener', event => event === 'appStateChange'
    ? new Promise(resolve => { completeRegistration = resolve; })
    : Promise.resolve({ remove: removeBack }));
  await mount();
  app.unmount();
  app = null;
  completeRegistration({ remove });
  await nextTick();
  assert.equal(remove.mock.callCount(), 1);
  assert.equal(removeBack.mock.callCount(), 0);
});

test('browser use requires login even before a device is cloud-bound', async () => {
  Capacitor.isNativePlatform = () => false;
  localDb.createMember({ name: '网页端隐藏会员', phone: '13800001111', initialBalance: 100 });
  await mount();
  assert.ok(document.body.textContent.includes('网页版需要登录后使用'));
  assert.ok(document.body.textContent.includes('安全登录'));
  assert.equal(document.body.textContent.includes('服务器地址'), false);
  assert.equal(document.body.textContent.includes('网页端隐藏会员'), false);
  assert.equal(document.querySelector('nav'), null);
});

function cloudProfile(role, t) {
  // 权限与收银 UI 测试模拟已登录的离线原生设备；浏览器重启测试使用真实恢复流程。
  if (role && t) {
    t.mock.method(cloudClient, 'restoreSession', async () => {});
    t.mock.method(cloudClient, 'sync', async () => {});
  }
  saveCloudState({ serverUrl: 'https://member.example.com', binding: { storeId: 'test-store' }, deviceId: crypto.randomUUID(),
    user: role ? { id: 'test-user', storeId: 'test-store', role, displayName: '店主', username: 'owner' } : null,
    revision: 1, outbox: [], activity: [], status: role ? 'synced' : 'login-required' });
}
test('a native app can read its local ledger after logout while cloud writes require the original account', async () => {
  localDb.createMember({ name: '私密会员', phone: '13800001111', initialBalance: 100 });
  cloudProfile(null);
  await mount();
  assert.ok(document.body.textContent.includes('私密会员'));
  assert.ok(document.querySelector('nav'));
  assert.equal(button('剪发扣款').disabled, true);
  await settings('account');
  assert.ok(document.body.textContent.includes('安全登录'));
});
test('read-only cloud accounts cannot initiate a charge or change service prices', async t => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  cloudProfile('viewer', t);
  await mount();
  assert.equal(button('剪发扣款').disabled, true);
  assert.equal(button('会员充值').disabled, true);
  await settings('services'); assert.equal(button('新增项目').disabled, true);
  assert.throws(() => localDb.consume({ memberId: member.id, amount: 38 }), /权限/);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
});
test('a cached signed-in cloud account records a charge and its pending operation through the UI', async t => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  cloudProfile('owner', t); await mount();
  button('剪发扣款').click(); await nextTick();
  button('精致洗剪吹 (').click(); await nextTick();
  button('确认扣除').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 6200);
  assert.equal(getCloudState().outbox.length, 1);
  assert.equal(getCloudState().outbox[0].method, 'consume');
});

test('downgraded accounts see export and cloud replacement controls without gaining write access', async t => {
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  cloudProfile('viewer', t);
  saveCloudState({ ...getCloudState(), status: 'conflict', conflictReason: 'permissions', outbox: [{ id: 'queued-charge' }] });
  await mount(); await settings('account');
  assert.ok(document.body.textContent.includes('账号权限已变化'));
  assert.equal(button('导出本机账本与待同步记录').disabled, false);
  assert.equal(button('采用云端账本').disabled, false);
  assert.equal(button('解除云端绑定').disabled, true);
  assert.equal([...document.querySelectorAll('button')].some(element => element.textContent.includes('确认上传恢复后的本机账本')), false);
  await settings('services');
  assert.equal(button('新增项目').disabled, true);
});

test('an initialization conflict shows reconciliation and disables unlink until the initial request is resolved', async t => {
  cloudProfile('owner', t);
  saveCloudState({ ...getCloudState(), status: 'conflict', conflictReason: 'bootstrap', bootstrap: { id: 'pending-bootstrap' } });
  await mount(); await settings('account');
  assert.ok(document.body.textContent.includes('其他设备已初始化云端'));
  assert.equal(button('采用云端账本').disabled, false);
  assert.equal(button('解除云端绑定').disabled, true);
});

test('the cloud-bound recovery screen restores a backup and requires explicit owner reconciliation', async t => {
  t.mock.method(console, 'error', () => {});
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  cloudProfile('owner', t);
  await mount();
  localDb.consume({ memberId: member.id, amount: 38 });
  const pending = getCloudState().outbox;
  localStorage.setItem('hairstudio_members_v2', '{broken');
  window.dispatchEvent(new window.Event('cloud-data-updated'));
  await new Promise(resolve => setTimeout(resolve, 20)); await nextTick();
  await settings('account');
  assert.ok(document.body.textContent.includes('本机账本无法读取'));
  assert.equal(button('采用云端账本').disabled, false);
  await selectBackup(backup);
  assert.equal(button('确认完全覆盖').disabled, false);
  button('确认完全覆盖').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
  assert.deepEqual(getCloudState().outbox, pending);
  assert.ok(document.body.textContent.includes('原待办已保留'));
  await settings('account');
  assert.equal(button('确认上传恢复后的本机账本').disabled, false);
  assert.equal(button('采用云端账本').disabled, false);
});

test('a corrupt cloud ledger can export its original storage and pending records through the UI', async t => {
  Capacitor.isNativePlatform = () => false;
  t.mock.method(console, 'error', () => {});
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  cloudProfile('owner', t);
  const pending = [{ id: 'queued-charge' }];
  saveCloudState({ ...getCloudState(), outbox: pending });
  localStorage.setItem('hairstudio_members_v2', '{broken');
  let exported, clicks = 0;
  t.mock.method(URL, 'createObjectURL', blob => { exported = blob.text(); return 'blob:review-export'; });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, 'click', () => { clicks++; });
  await mount();
  await settings('account');
  button('导出本机账本与待同步记录').click();
  await new Promise(resolve => setTimeout(resolve, 20)); await nextTick();
  assert.equal(clicks, 1);
  const content = JSON.parse(await exported);
  assert.equal(content.data, null);
  assert.equal(content.storage.hairstudio_members_v2, '{broken');
  assert.deepEqual(content.cloud.outbox, pending);
  assert.ok(document.body.textContent.includes('已发起备份导出'));
});

test('a browser restart exposes login and hides the stale signed-in ledger while retaining pending operations', async () => {
  Capacitor.isNativePlatform = () => false;
  localDb.createMember({ name: '私密会员', phone: '13800001111', initialBalance: 100 });
  cloudProfile('owner');
  const pending = [{ id: 'queued-charge', actorId: 'test-user' }];
  saveCloudState({ ...getCloudState(), status: 'conflict', conflictReason: 'data', outbox: pending });
  await mount();
  await new Promise(resolve => setTimeout(resolve, 20)); await nextTick();
  assert.equal(getCloudState().user, null);
  assert.equal(getCloudState().status, 'login-required');
  assert.deepEqual(getCloudState().outbox, pending);
  assert.ok(document.body.textContent.includes('安全登录'));
  assert.equal(document.body.textContent.includes('私密会员'), false);
  assert.equal(document.body.textContent.includes('同步完成'), false);
});

async function nativeBackListener(t) {
  let back;
  t.mock.method(nativeApp, 'addListener', async (name, callback) => {
    if (name === 'backButton') back = callback;
    return { remove: async () => {} };
  });
  await mount();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(back);
  return back;
}

test('native root exits on the third consecutive back press and resets after two seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const exit = t.mock.method(nativeApp, 'exitApp', async () => {});
  const back = await nativeBackListener(t);
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('再按两次返回键退出应用'));
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('再按一次返回键退出应用'));
  assert.equal(exit.mock.callCount(), 0);
  t.mock.timers.tick(2001);
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('再按两次返回键退出应用'));
  await back();
  await back();
  assert.equal(exit.mock.callCount(), 1);
});

test('native back closes forms and traverses settings levels before counting exit presses', async t => {
  const exit = t.mock.method(nativeApp, 'exitApp', async () => {});
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const before = localDb.readBackupState();
  const back = await nativeBackListener(t);
  button('会员充值').click(); await nextTick();
  await back(); await nextTick();
  assert.equal(document.querySelector('.recharge-plans'), null);
  assert.deepEqual(localDb.readBackupState(), before);
  await settings('backup-files');
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('本地快照'));
  assert.equal(document.querySelector('input[type="file"]'), null);
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('日常经营'));
  await back(); await nextTick();
  assert.ok(document.querySelector('.dashboard-card'));
  assert.equal(exit.mock.callCount(), 0);
  await back(); await back();
  document.querySelector('.app-shell').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
  await back();
  assert.equal(exit.mock.callCount(), 0);
  await back(); await back();
  assert.equal(exit.mock.callCount(), 1);
});

test('settings groups hide detailed forms until entering their category', async () => {
  await mount(); await settings();
  assert.ok(document.body.textContent.includes('日常经营'));
  assert.ok(document.body.textContent.includes('账号与云端'));
  assert.equal(document.querySelector('input'), null);
  assert.equal(document.body.textContent.includes('精致洗剪吹'), false);
  button('数据备份').click(); await nextTick();
  assert.ok(document.body.textContent.includes('本地快照'));
  assert.equal(document.querySelector('input[type="file"]'), null);
  button('导出与恢复').click(); await nextTick();
  assert.ok(document.querySelector('input[type="file"]'));
  assert.equal(document.body.textContent.includes('加载账号列表'), false);
  document.querySelector('[aria-label="返回上一级设置"]').click(); await nextTick();
  assert.equal(document.querySelector('input[type="file"]'), null);
  await settings('account');
  assert.ok(document.body.textContent.includes('安全登录'));
  assert.equal(document.body.textContent.includes('一键备份所有账本'), false);
});

test('native cached account remains usable when secure credentials cannot be read at startup', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(cloudClient, 'sync', async () => {});
  const member = localDb.createMember({ name: '离线会员', phone: '13800001111', initialBalance: 100 });
  cloudProfile('owner');
  await mount();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.equal(getCloudState().user.id, 'test-user');
  assert.equal(getCloudState().syncLoginRequired, true);
  assert.ok(document.querySelector('.dashboard-card'));
  assert.equal(button('剪发扣款').disabled, false);
  button('剪发扣款').click(); await nextTick();
  button('精致洗剪吹 (').click(); await nextTick();
  button('确认扣除').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 6200);
  assert.equal(getCloudState().outbox[0].actorId, 'test-user');
  button('知道了').click(); await nextTick();
  await settings('account');
  assert.ok(document.body.textContent.includes('可继续离线使用'));
  assert.ok(document.body.textContent.includes('安全登录'));
});

test('ordinary long-press menus are suppressed while input menus remain available and phone copying is explicit', async t => {
  t.mock.method(console, 'warn', () => {});
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  const label = document.querySelector('.dashboard-card');
  const context = new dom.window.Event('contextmenu', { bubbles: true, cancelable: true });
  label.dispatchEvent(context);
  assert.equal(context.defaultPrevented, true);
  const inputContext = new dom.window.Event('contextmenu', { bubbles: true, cancelable: true });
  document.querySelector('header input').dispatchEvent(inputContext);
  assert.equal(inputContext.defaultPrevented, false);
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => copied.push(text) }, configurable: true });
  t.after(() => { delete navigator.clipboard; });
  Capacitor.isNativePlatform = () => false;
  document.querySelector('[aria-label="复制会员手机号"]').click();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.deepEqual(copied, ['13800001111']);
  assert.equal(document.querySelector('[class*="z-40"]'), null);
  assert.ok(document.body.textContent.includes('手机号已复制'));
});
