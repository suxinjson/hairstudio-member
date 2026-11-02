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
const nativeAppPath = join(directory, 'native-app.mjs');
await writeFile(nativeAppPath, 'export const App = { addListener() { throw new Error("Unexpected native subscription"); } };');
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
      : specifier.startsWith('.') ? new URL(specifier, sourceUrl).href : pathToFileURL(require.resolve(specifier)).href;
    return `from ${quote}${target}${quote}`;
  });
  await writeFile(outputPath, rewritten);
}
await compileComponent(new URL('../src/components/Keypad.vue', import.meta.url), keypadPath);
const appPath = join(directory, 'app.mjs');
await compileComponent(new URL('../src/App.vue', import.meta.url), appPath, pathToFileURL(keypadPath).href);
const { default: App } = await import(pathToFileURL(appPath).href);
const { createApp, nextTick } = await import(vueUrl);
const { localDb } = await import('../src/storage.js');

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
  globalThis.localStorage = new MemoryStorage();
  document.body.innerHTML = '<div id="app"></div>';
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
async function settings() {
  [...document.querySelectorAll('nav button')].find(element => element.textContent.includes('设置')).click();
  await nextTick();
}
async function selectBackup(content) {
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
  await settings();
  localStorage.failKey = 'hairstudio_local_snapshots_v1';
  button('立即归档').click();
  await nextTick();
  assert.ok(document.body.textContent.includes('归档失败'));
  assert.equal(document.body.textContent.includes('已在手机本地生成一份最新账本快照'), false);
  assert.equal(localDb.getLocalSnapshots().length, 0);
});

test('external export succeeds with an explicit warning when its optional local snapshot fails', async t => {
  t.mock.method(console, 'warn', () => {});
  const received = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: async request => { received.push(request.files[0]); }, configurable: true });
  t.after(() => { delete navigator.canShare; delete navigator.share; });
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  await settings();
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
  document.querySelector('[class*="z-40"] button').click();
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
  t.mock.method(nativeApp, 'addListener', async (event, listener) => {
    assert.equal(event, 'appStateChange');
    onAppStateChange = listener;
    return { remove };
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
});

test('a native listener that finishes registering after unmount is removed immediately', async t => {
  t.mock.method(Capacitor, 'isNativePlatform', () => true);
  let completeRegistration;
  const remove = t.mock.fn(async () => {});
  t.mock.method(nativeApp, 'addListener', () => new Promise(resolve => { completeRegistration = resolve; }));
  await mount();
  app.unmount();
  app = null;
  completeRegistration({ remove });
  await nextTick();
  assert.equal(remove.mock.callCount(), 1);
});
