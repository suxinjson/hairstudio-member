import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost' });
for (const key of ['window', 'document', 'Document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'FileReader', 'location']) {
  globalThis[key] = dom.window[key];
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
const { parse, compileScript } = await import('@vue/compiler-sfc');
const require = createRequire(import.meta.url);
const vueUrl = pathToFileURL(require.resolve('vue')).href;
const directory = await mkdtemp(join(tmpdir(), 'member-ui-test-'));
const keypadPath = join(directory, 'keypad.mjs');
const cloudSettingsPath = join(directory, 'cloud-settings.mjs');
const customersPath = join(directory, 'customers.mjs');
const nativeAppPath = join(directory, 'native-app.mjs');
await writeFile(nativeAppPath, 'export const App = { addListener() { throw new Error("Unexpected native subscription"); }, async exitApp() {} };');
const nativeAppUrl = pathToFileURL(nativeAppPath).href;
const { App: nativeApp } = await import(nativeAppUrl);
const { Capacitor } = await import('@capacitor/core');

const compiledCache = new Map();

async function compileVueFile(sourceUrl, outputPath) {
  const fileKey = String(sourceUrl);
  if (compiledCache.has(fileKey)) return compiledCache.get(fileKey);

  const outPath = outputPath || join(directory, 'comp-' + Math.random().toString(36).slice(2, 9) + '.mjs');
  const outUrl = pathToFileURL(outPath).href;
  compiledCache.set(fileKey, outUrl);

  const source = await readFile(new URL(fileKey), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: outPath, inlineTemplate: true }).content;

  const matches = [...script.matchAll(/from (['"])([^'"]+)\1/g)];
  let rewritten = script;
  for (const match of matches) {
    const [full, quote, specifier] = match;
    let target;
    if (specifier === 'vue') target = vueUrl;
    else if (specifier === '@capacitor/app') target = nativeAppUrl;
    else if (specifier.endsWith('.vue')) {
      const depUrl = new URL(specifier, fileKey);
      target = await compileVueFile(depUrl);
    } else if (specifier.startsWith('.')) {
      target = new URL(specifier, fileKey).href;
    } else {
      target = pathToFileURL(require.resolve(specifier)).href;
    }
    rewritten = rewritten.replace(full, `from ${quote}${target}${quote}`);
  }
  await writeFile(outPath, rewritten);
  return outUrl;
}

await compileVueFile(new URL('../src/components/Keypad.vue', import.meta.url), keypadPath);
await compileVueFile(new URL('../src/components/CloudSettings.vue', import.meta.url), cloudSettingsPath);
await compileVueFile(new URL('../src/components/Customers.vue', import.meta.url), customersPath);
const appPath = join(directory, 'app.mjs');
await compileVueFile(new URL('../src/App.vue', import.meta.url), appPath);
const { default: App } = await import(pathToFileURL(appPath).href);
const { default: CloudSettings } = await import(pathToFileURL(cloudSettingsPath).href);
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
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  // Wait for the actual FileReader event instead of a fixed delay under full-suite load.
  const NativeReader = globalThis.FileReader;
  let loaded;
  const completed = new Promise(resolve => { loaded = resolve; });
  globalThis.FileReader = class extends NativeReader {
    constructor() { super(); this.addEventListener('loadend', loaded, { once: true }); }
  };
  try { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }
  finally { globalThis.FileReader = NativeReader; }
  let timer;
  try { await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('backup read did not complete')), 3000); })]); }
  finally { clearTimeout(timer); }
  await nextTick();
}

test('mobile headers show checking and failure instead of confirmed synchronization', async t => {
  t.mock.method(cloudClient, 'start', async () => () => {});
  t.mock.method(cloudClient, 'sync', async () => {});
  const state = { serverUrl: 'https://localhost', binding: { storeId: 'store-A' }, deviceId: 'device-test-123456',
    user: { id: 'owner-A', storeId: 'store-A', role: 'owner', displayName: '店主' }, outbox: [], activity: [], revision: 1,
    status: 'synced', syncStatus: 'error', syncError: '服务器繁忙', online: true };
  let update;
  t.mock.method(cloudClient, 'snapshot', () => state);
  t.mock.method(cloudClient, 'subscribe', listener => { update = listener; listener(state); return () => {}; });
  await mount();
  assert.match(document.body.textContent, /同步失败/); assert.doesNotMatch(document.body.textContent, /已同步/);
  update({ ...state, syncStatus: 'checking', syncError: '' }); await nextTick();
  assert.match(document.body.textContent, /同步中/); assert.doesNotMatch(document.body.textContent, /已同步/);
  update({ ...state, syncStatus: 'confirmed', syncError: '' }); await nextTick();
  assert.match(document.body.textContent, /已同步/);
});

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

test('a damaged transaction journal can be exported from the backup screen and then restored', async t => {
  t.mock.method(console, 'error', () => {});
  Capacitor.isNativePlatform = () => false;
  cloudProfile('owner', t);
  const received = [];
  Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(navigator, 'share', { value: async request => { received.push(request.files[0]); }, configurable: true });
  t.after(() => { delete navigator.canShare; delete navigator.share; });
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  const backup = localDb.exportBackupData({ archiveSnapshot: false });
  localStorage.setItem('hairstudio_pending_write_v1', '{broken');
  await mount();
  assert.ok(document.body.textContent.includes('当前账本无法读取'));
  assert.equal(button('导出账本原始数据').disabled, false);
  button('导出账本原始数据').click();
  await new Promise(resolve => setTimeout(resolve, 10)); await nextTick();
  const raw = JSON.parse(await received[0].text());
  assert.equal(raw.pendingWrite, '{broken');
  assert.equal(raw.data, null);
  button('知道了').click(); await nextTick();
  await selectBackup(backup);
  button('确认完全覆盖').click(); await nextTick();
  assert.equal(localDb.getMembers()[0].balance, 10000);
  assert.equal(document.body.textContent.includes('当前账本无法读取'), false);
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

test('the recharge form accepts decimals and credits the exact confirmed total', async t => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111' });
  await mount();
  document.querySelector('.customer-open').click(); await nextTick();
  button('额度充值').click();
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
  // The receipt uses the real clipboard contract: success resolves without a value.
  t.mock.method(Capacitor, 'isNativePlatform', () => false);
  let copied, denied = false;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
    if (denied) throw new Error('剪贴板访问被拒绝');
    copied = text;
  } } });
  t.after(() => { delete navigator.clipboard; });
  button('一键复制致谢文案').click();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.ok(copied.includes('20.06'));
  assert.ok(document.body.textContent.includes('通知文本已复制到剪贴板'));
  denied = true;
  button('一键复制致谢文案').click();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.ok(document.body.textContent.includes('剪贴板访问被拒绝'));
});

async function openRecharge() {
  document.querySelector('.customer-open').click(); await nextTick();
  button('额度充值').click(); await nextTick();
}
async function inputValue(selector, value) {
  const input = document.querySelector(selector); assert.ok(input, selector);
  input.value = value; input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await nextTick();
}

test('recharge calculates the configured gift, preserves manual edits and allows deselecting a channel', async () => {
  const member = localDb.createMember({ name: '赠送客户', phone: '13800005002' });
  localDb.saveRechargeSettings({ giftEnabled: true, giftRate: 12.5 });
  await mount(); await openRecharge();
  assert.ok([...document.querySelectorAll('.recharge-channels button')].every(el => el.getAttribute('aria-pressed') === 'false'));
  await inputValue('#recharge-pay', '19.99');
  assert.equal(document.querySelector('#recharge-gift').value, '2.5');
  await inputValue('#recharge-gift', '0.07');
  // Unrelated account refreshes must not overwrite a cashier's manual gift amount.
  window.dispatchEvent(new dom.window.Event('focus')); await nextTick();
  assert.equal(document.querySelector('#recharge-gift').value, '0.07');
  const channel = document.querySelector('.recharge-channels button');
  channel.click(); await nextTick(); assert.equal(channel.getAttribute('aria-pressed'), 'true');
  channel.click(); await nextTick(); assert.equal(channel.getAttribute('aria-pressed'), 'false');
  button('核对充值信息').click(); await nextTick();
  assert.equal(document.querySelector('.recharge-confirm-dialog').textContent.includes('收款方式'), false);
  button('确认充值').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 2006);
  assert.equal(localDb.getLedgers()[0].remark.includes('微信'), false);
});

test('disabled gifts are hidden in the drawer and confirmation and only actual pay is credited', async () => {
  const member = localDb.createMember({ name: '普通客户', phone: '13800005003' });
  localDb.saveRechargeSettings({ giftEnabled: false, giftRate: 20 });
  await mount(); await openRecharge();
  assert.equal(document.querySelector('#recharge-gift'), null);
  assert.equal(document.querySelector('.recharge-plans').textContent.includes('送'), false);
  document.querySelector('.recharge-plans button').click(); await nextTick();
  assert.equal(document.querySelector('.recharge-credit-preview strong').textContent, '¥200.00');
  button('核对充值信息').click(); await nextTick();
  assert.equal(document.querySelector('.recharge-confirm-dialog').textContent.includes('赠送'), false);
  button('确认充值').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 20000);
});

test('a gift policy changed during confirmation requires a second review', async () => {
  const member = localDb.createMember({ name: '核对规则客户', phone: '13800005004' });
  await mount(); await openRecharge(); await inputValue('#recharge-pay', '100');
  button('核对充值信息').click(); await nextTick();
  assert.ok(document.querySelector('.recharge-confirm-dialog').textContent.includes('110.00'));
  localDb.saveRechargeSettings({ giftEnabled: false, giftRate: 10 });
  button('确认充值').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 0);
  assert.equal(document.querySelector('#recharge-gift'), null);
  assert.equal(document.querySelector('.recharge-confirm-dialog').textContent.includes('赠送'), false);
  assert.ok(document.body.textContent.includes('规则已变化'));
  button('确认充值').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
});

test('service settings validate gift rates and allow switching off after an invalid entry', async () => {
  await mount(); await settings('services');
  await inputValue('#recharge-gift-rate', '12.5');
  button('保存赠送设置').click(); await nextTick();
  assert.deepEqual(localDb.getRechargeSettings(), { giftEnabled: true, giftRate: 12.5 });
  await inputValue('#recharge-gift-rate', '101');
  assert.equal(button('保存赠送设置').disabled, true);
  document.querySelector('[role="switch"]').click(); await nextTick();
  assert.equal(document.querySelector('#recharge-gift-rate'), null);
  assert.equal(button('保存赠送设置').disabled, false);
  button('保存赠送设置').click(); await nextTick();
  assert.deepEqual(localDb.getRechargeSettings(), { giftEnabled: false, giftRate: 12.5 });
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
  document.querySelector('.customer-open').click();
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
  document.querySelectorAll('nav button')[1].click();
  await nextTick();
  assert.ok(document.body.textContent.includes('138 0000 1111'));
});

async function assertDailySummary(date, recharge) {
  if (!document.querySelector('.dashboard-card')) {
    document.querySelectorAll('nav button')[1].click(); await nextTick();
    document.querySelector('#ledger-summary-tab').click(); await nextTick();
  }
  assert.ok(document.querySelector('header').textContent.includes(date));
  const rechargeCard = document.querySelector('.dashboard-card .grid > div');
  assert.match(rechargeCard.textContent, new RegExp(`¥\\s*${recharge.replace('.', '\\.')}\\b`));
}

test('midnight refreshes the date and today totals without a transaction, and stops on unmount', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date(2026, 10, 2, 23, 59, 59) });
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  await assertDailySummary('11月2日', '100.00');
  t.mock.timers.tick(1000);
  await nextTick();
  await assertDailySummary('11月3日', '0.00');
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await nextTick();
  await assertDailySummary('11月4日', '0.00');
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
    await assertDailySummary('11月2日', '100.00');
    t.mock.timers.setTime(new Date(2026, 10, 3, 12).getTime());
    const target = event === 'focus' ? window : document;
    if (event === 'visibilitychange') {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      t.after(() => { delete document.visibilityState; });
    }
    target.dispatchEvent(new dom.window.Event(event));
    await nextTick();
    await assertDailySummary('11月3日', '0.00');
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
  await assertDailySummary('11月2日', '100.00');
  t.mock.timers.setTime(new Date(2026, 10, 3, 12).getTime());
  onAppStateChange({ isActive: false });
  await nextTick();
  await assertDailySummary('11月2日', '100.00');
  onAppStateChange({ isActive: true });
  await nextTick();
  await assertDailySummary('11月3日', '0.00');
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

test('browser login identity without a bound ledger keeps customers and business navigation hidden', async t => {
  Capacitor.isNativePlatform = () => false;
  localDb.createMember({ name: '未加载账本私密会员', phone: '13800001111', initialBalance: 100 });
  cloudProfile('viewer', t);
  saveCloudState({ ...getCloudState(), binding: null, status: 'needs-choice' });
  await mount();
  assert.equal(document.querySelector('.customer-row'), null);
  assert.equal(document.querySelector('nav'), null);
  assert.ok(document.body.textContent.includes('采用云端账本'));
  assert.throws(() => localDb.recharge({ memberId: localDb.getMembers()[0].id, actualPay: 50 }), /权限|绑定/);
});

test('an unbound native viewer can read the local ledger but cannot change it', async t => {
  const member = localDb.createMember({ name: '本机会员', phone: '13800001111', initialBalance: 100 });
  cloudProfile('viewer', t);
  saveCloudState({ ...getCloudState(), binding: null, status: 'needs-choice' });
  await mount();
  assert.ok(document.body.textContent.includes('本机会员'));
  assert.equal(button('扣款').disabled, true);
  assert.throws(() => localDb.recharge({ memberId: member.id, actualPay: 50 }), /权限/);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
});

test('cashier starts with quick actions and the daily summary has a separate ledger tab', async () => {
  localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  await mount();
  assert.equal(document.querySelector('.dashboard-card'), null);
  assert.ok(button('扣款'));
  assert.equal(document.querySelectorAll('nav button').length, 3);
  assert.ok(document.querySelector('.customer-open'));
  document.querySelectorAll('nav button')[1].click(); await nextTick();
  assert.equal(document.querySelector('#ledger-transactions-tab').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('.dashboard-card'), null);
  document.querySelector('#ledger-summary-tab').click(); await nextTick();
  assert.equal(document.querySelector('#ledger-summary-tab').getAttribute('aria-selected'), 'true');
  assert.ok(document.querySelector('.dashboard-card').textContent.includes('今日小店收银简报'));
  assert.equal(document.querySelector('header input'), null);
  document.querySelector('#ledger-transactions-tab').click(); await nextTick();
  assert.ok(document.querySelector('header input'));
  assert.equal(document.querySelector('.dashboard-card'), null);
});

test('member and ledger fuzzy searches respond to input, blur, change and clear', async () => {
  localDb.createMember({ name: '张阿姨', phone: '13800001111', initialBalance: 100 });
  localDb.createMember({ name: '李大姐', phone: '13900002222', initialBalance: 200 });
  await mount();
  const input = document.querySelector('header input');
  async function search(value, event) {
    input.value = value;
    input.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
    await nextTick();
  }
  await search('阿', 'input');
  assert.equal(document.querySelectorAll('.customer-row').length, 1);
  assert.ok(document.querySelector('.customer-row').textContent.includes('张阿姨'));
  await search('2222', 'blur');
  assert.equal(document.querySelectorAll('.customer-row').length, 1);
  assert.ok(document.querySelector('.customer-row').textContent.includes('李大姐'));
  await search('查无此人', 'change');
  assert.equal(document.querySelectorAll('.customer-row').length, 0);
  document.querySelector('header .header-search button').click(); await nextTick();
  assert.equal(document.querySelectorAll('.customer-row').length, 2);
  document.querySelectorAll('nav button')[1].click(); await nextTick();
  await search('1111', 'input');
  assert.ok(document.querySelector('#ledger-transactions').textContent.includes('张阿姨'));
  assert.equal(document.querySelector('#ledger-transactions').textContent.includes('李大姐'), false);
  await search('大姐', 'blur');
  assert.ok(document.querySelector('#ledger-transactions').textContent.includes('李大姐'));
  assert.equal(document.querySelector('#ledger-transactions').textContent.includes('张阿姨'), false);
  await search('储值', 'change');
  assert.ok(document.querySelector('#ledger-transactions').textContent.includes('张阿姨'));
  assert.ok(document.querySelector('#ledger-transactions').textContent.includes('李大姐'));
});

test('Chinese composition searches after committing the completed input', async () => {
  localDb.createMember({ name: '张阿姨', phone: '13800001111' });
  localDb.createMember({ name: '李大姐', phone: '13900002222' });
  await mount();
  const input = document.querySelector('header input');
  input.dispatchEvent(new dom.window.Event('compositionstart', { bubbles: true }));
  input.value = '阿';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await nextTick();
  assert.equal(document.querySelectorAll('.customer-row').length, 2);
  input.dispatchEvent(new dom.window.Event('compositionend', { bubbles: true }));
  await nextTick();
  assert.equal(document.querySelectorAll('.customer-row').length, 1);
  assert.ok(document.querySelector('.customer-row').textContent.includes('张阿姨'));
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
  assert.equal(button('扣款').disabled, true);
  await settings('account');
  assert.ok(document.body.textContent.includes('安全登录'));
});

for (const native of [true, false]) {
  test(`login uses ${native ? 'the saved native server' : 'the browser origin'} when an older server address is cached`, async t => {
    Capacitor.isNativePlatform = () => native;
    cloudProfile(null);
    const pending = [{ id: 'pending-charge', actorId: 'test-user' }];
    saveCloudState({ ...getCloudState(), outbox: pending });
    const login = t.mock.method(cloudClient, 'login', async () => {});
    t.mock.method(cloudClient, 'sync', async () => {});
    app = createApp(CloudSettings);
    app.mount('#app');
    await nextTick();
    for (const [selector, value] of [['input[autocomplete="username"]', 'owner'], ['input[type="password"]', 'correct-password']]) {
      const input = document.querySelector(selector);
      input.value = value;
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(login.mock.callCount(), 1);
    assert.equal(login.mock.calls[0].arguments[0], native ? 'https://member.example.com' : 'https://localhost');
    assert.equal(login.mock.calls[0].arguments[1], 'owner');
    assert.deepEqual(getCloudState().outbox, pending);
  });
}
test('read-only cloud accounts cannot initiate a charge or change service prices', async t => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  cloudProfile('viewer', t);
  await mount();
  assert.equal(button('扣款').disabled, true);
  document.querySelector('.customer-open').click(); await nextTick();
  assert.equal(button('额度充值').disabled, true);
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })); await nextTick();
  await settings('services'); assert.equal(button('新增项目').disabled, true);
  assert.throws(() => localDb.consume({ memberId: member.id, amount: 38 }), /权限/);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);
});
test('a cached signed-in cloud account records a charge and its pending operation through the UI', async t => {
  const member = localDb.createMember({ name: '张姐', phone: '13800001111', initialBalance: 100 });
  cloudProfile('owner', t); await mount();
  button('扣款').click(); await nextTick();
  document.querySelector('[aria-label="精致洗剪吹 (¥38)"]').click(); await nextTick();
  button('确认扣除').click(); await nextTick();
  button('确认扣款').click(); await nextTick();
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
  document.querySelector('.customer-open').click(); await nextTick();
  button('额度充值').click(); await nextTick();
  await back(); await nextTick();
  assert.equal(document.querySelector('.recharge-plans'), null);
  assert.deepEqual(localDb.readBackupState(), before);
  await back(); await nextTick();
  assert.equal(document.querySelector('.member-detail-sheet'), null);
  await settings('backup-files');
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('本地快照'));
  assert.equal(document.querySelector('input[type="file"]'), null);
  await back(); await nextTick();
  assert.ok(document.body.textContent.includes('日常经营'));
  await back(); await nextTick();
  assert.ok(document.querySelector('.customer-row'));
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
  assert.ok(document.querySelector('.customer-row'));
  assert.equal(button('扣款').disabled, false);
  button('扣款').click(); await nextTick();
  document.querySelector('[aria-label="精致洗剪吹 (¥38)"]').click(); await nextTick();
  button('确认扣除').click(); await nextTick();
  button('确认扣款').click(); await nextTick();
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
  const label = document.querySelector('.customer-row');
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
  document.querySelector('.customer-open').click(); await nextTick();
  document.querySelector('[aria-label="复制会员手机号"]').click();
  await new Promise(resolve => setImmediate(resolve)); await nextTick();
  assert.deepEqual(copied, ['13800001111']);
  assert.ok(document.querySelector('.member-detail-sheet'));
  assert.ok(document.body.textContent.includes('手机号已复制'));
});

test('haircut consume keypad stays docked, opens for editing and stays collapsed for presets, allows direct amount modification and confirms with popup', async t => {
  t.mock.method(console, 'warn', () => {});
  const member = localDb.createMember({ name: '李四', phone: '13900002222', initialBalance: 100 });
  await mount();

  // 1. 打开剪发扣款抽屉
  button('扣款').click();
  await nextTick();

  // 标准服务无需键盘；需要改价时再展开。
  assert.ok(button('展开键盘'));
  button('展开键盘').click(); await nextTick();
  assert.ok(button('收起键盘'));
  assert.ok(button('确认扣除'));

  // 2. 点击收起键盘
  button('收起键盘').click();
  await nextTick();
  assert.ok(button('展开键盘'));
  assert.ok(button('改金额'));

  // 3. 点击金额卡片数字区域 -> 重新弹出展开键盘
  const amountCard = document.querySelector('.consume-amount-edit');
  assert.ok(amountCard);
  amountCard.click();
  await nextTick();
  assert.ok(button('收起键盘'));

  // 4. 再次收起后点击服务预设按钮 -> 保持键盘收起并带入金额
  button('收起键盘').click();
  await nextTick();
  document.querySelector('[aria-label="精致洗剪吹 (¥38)"]').click();
  await nextTick();
  assert.ok(button('展开键盘'));
  assert.ok(amountCard.textContent.includes('38'));
  button('展开键盘').click(); await nextTick();

  // 5. 带入数字后不要清空数字，而是尾部修改：
  // 此时金额为 38，点击退格键删除末尾 8 -> 变为 3
  const backspaceBtn = document.querySelector('.keypad-confirm').parentElement.querySelector('svg').closest('button');
  backspaceBtn.click();
  await nextTick();
  assert.ok(amountCard.textContent.includes('3'));
  assert.equal(amountCard.textContent.includes('38'), false);

  // 点击数字 5 -> 尾部追加 5，变为 35
  const keyBtn = text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
  keyBtn('5').click();
  await nextTick();
  assert.ok(amountCard.textContent.includes('35'));

  // 6. 点击确认扣除 -> 先弹出消费金额确认框，核对 35 元，并未立即扣款
  button('确认扣除').click();
  await nextTick();
  assert.ok(document.body.textContent.includes('请核对扣款金额'));
  assert.ok(document.body.textContent.includes('李四'));
  assert.ok(document.body.textContent.includes('35.00'));
  assert.ok(button('返回修改'));
  assert.ok(button('确认扣款'));
  assert.equal(localDb.getMemberById(member.id).balance, 10000); // 余额未扣除

  // 7. 点击返回修改 -> 确认框关闭，扣款抽屉仍保留，余额仍未变
  button('返回修改').click();
  await nextTick();
  assert.equal(document.body.textContent.includes('请核对扣款金额'), false);
  assert.equal(localDb.getMemberById(member.id).balance, 10000);

  // 编辑文字说明时收起金额键盘；回到改价时失焦，避免同时打开系统输入法。
  const description = document.querySelector('.consume-description input');
  description.focus(); await nextTick();
  assert.equal(document.activeElement, description);
  assert.ok(button('展开键盘'));
  button('展开键盘').click(); await nextTick();
  assert.notEqual(document.activeElement, description);
  assert.ok(amountCard.textContent.includes('35'));

  // 8. 再次点击确认扣除并点击确认扣款 -> 正式扣除 35 元 (10000 - 3500 = 6500)
  button('确认扣除').click();
  await nextTick();
  button('确认扣款').click();
  await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 6500);
});

test('haircut consume modal back button first collapses keypad, second back closes modal', async t => {
  t.mock.method(console, 'warn', () => {});
  const member = localDb.createMember({ name: '王五', phone: '13900003333', initialBalance: 100 });
  const back = await nativeBackListener(t);

  // 1. 打开剪发扣款抽屉
  button('扣款').click();
  await nextTick();
  button('展开键盘').click(); await nextTick();

  // 键盘默认展开
  assert.ok(button('收起键盘'));
  assert.equal(document.body.textContent.includes('王五'), true);

  // 2. 第一次返回：收起键盘，扣款抽屉仍保留
  await back();
  await nextTick();

  assert.ok(button('展开键盘'));
  assert.equal(document.body.textContent.includes('王五'), true);

  // 3. 第二次返回：关闭扣款抽屉
  await back();
  await nextTick();

  assert.equal(document.querySelector('.modal-title'), null);
});

test('haircut consume confirmation back button first closes confirmation, then collapses keypad, then closes drawer', async t => {
  t.mock.method(console, 'warn', () => {});
  const member = localDb.createMember({ name: '赵六', phone: '13900004444', initialBalance: 100 });
  const back = await nativeBackListener(t);

  // 1. 打开剪发扣款抽屉并选服务
  button('扣款').click();
  await nextTick();
  button('展开键盘').click(); await nextTick();
  document.querySelector('[aria-label="精致洗剪吹 (¥38)"]').click();
  await nextTick();
  button('展开键盘').click(); await nextTick();

  // 2. 点击确认扣除 -> 弹出消费确认框
  button('确认扣除').click();
  await nextTick();
  assert.ok(document.body.textContent.includes('请核对扣款金额'));

  // 3. 第一次返回：关闭确认框，回到扣款抽屉
  await back();
  await nextTick();
  assert.equal(document.body.textContent.includes('请核对扣款金额'), false);
  assert.equal(document.body.textContent.includes('赵六'), true);
  assert.ok(button('收起键盘'));

  // 4. 第二次返回：收起数字键盘
  await back();
  await nextTick();
  assert.ok(button('展开键盘'));
  assert.equal(document.body.textContent.includes('赵六'), true);

  // 5. 第三次返回：关闭扣款抽屉
  await back();
  await nextTick();
  assert.equal(document.querySelector('.modal-title'), null);
});

test('clicking haircut modal backdrop first collapses the keypad, next click closes the drawer', async t => {
  t.mock.method(console, 'warn', () => {});
  localDb.createMember({ name: '孙七', phone: '13900005555', initialBalance: 100 });
  await mount();

  button('扣款').click();
  await nextTick();
  button('展开键盘').click(); await nextTick();

  const backdrop = document.querySelector('.modal-title').closest('.fixed.inset-0');
  assert.ok(backdrop);
  assert.ok(button('收起键盘'));

  // 点击背景遮罩第一次：收起键盘
  backdrop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.ok(button('展开键盘'));
  assert.equal(document.body.textContent.includes('孙七'), true);

  // 点击背景遮罩第二次：关闭抽屉
  backdrop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await nextTick();
  assert.equal(document.querySelector('.modal-title'), null);
});

test('pressing Escape on keyboard follows the layered back hierarchy', async t => {
  t.mock.method(console, 'warn', () => {});
  localDb.createMember({ name: '周八', phone: '13900006666', initialBalance: 100 });
  await mount();

  button('扣款').click();
  await nextTick();
  button('展开键盘').click(); await nextTick();
  assert.ok(button('收起键盘'));

  // 按 Escape 键第一次：收起键盘
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  assert.ok(button('展开键盘'));
  assert.equal(document.body.textContent.includes('周八'), true);

  // 按 Escape 键第二次：关闭扣款抽屉
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await nextTick();
  assert.equal(document.querySelector('.modal-title'), null);
});

test('unified customer navigation filters low balances and debts without duplicating the directory', async t => {
  t.mock.method(console, 'warn', () => {});
  localDb.createMember({ name: '储值客户', phone: '13800001001', initialBalance: 100 });
  localDb.createMember({ name: '低余额客户', phone: '13800001002', initialBalance: 20 });
  const debt = localDb.createMember({ name: '欠款客户甲', phone: '13800001003' });
  localDb.consume({ memberId: debt.id, amount: 38, allowDebt: true });
  await mount();
  assert.deepEqual([...document.querySelectorAll('nav button')].map(b => b.textContent.trim()), ['会员', '流水', '设置']);
  assert.equal(document.querySelectorAll('.customer-row').length, 3);
  assert.ok(document.querySelector('.customer-row-debt').textContent.includes('−¥38.00'));
  assert.ok(document.querySelector('.customer-debt-summary').textContent.includes('38.00'));
  document.querySelectorAll('.customer-filters button')[2].click(); await nextTick();
  assert.equal(document.querySelectorAll('.customer-row').length, 1);
  assert.ok(document.querySelector('.customer-row').textContent.includes('低余额客户'));
  document.querySelector('.customer-debt-summary').click(); await nextTick();
  assert.equal(document.querySelectorAll('.customer-row').length, 1);
  assert.ok(document.querySelector('.customer-row').textContent.includes('欠款客户甲'));
  document.querySelector('.customer-open').click(); await nextTick();
  assert.ok(document.querySelector('.member-balance-debt'));
  assert.ok(button('充值 / 还款'));
  assert.equal(document.body.textContent.includes('删除注销此会员'), false);
});

test('recent customers follow actual non-reversed consumption instead of profile edits or recharges', async t => {
  t.mock.method(console, 'warn', () => {});
  const first = localDb.createMember({ name: '近期来店', phone: '13800001001', initialBalance: 100 });
  const second = localDb.createMember({ name: '只改档案', phone: '13800001002', initialBalance: 100 });
  localDb.consume({ memberId: first.id, amount: 38 });
  localDb.updateMember(second.id, { notes: '今天修改' });
  localDb.recharge({ memberId: second.id, actualPay: 50 });
  await mount();
  assert.ok(document.querySelector('.customer-row').textContent.includes('近期来店'));
  assert.ok(document.querySelectorAll('.customer-row')[1].textContent.includes('尚未消费'));
});

test('overdraft warns about additional and total debt and requires acknowledgement on every confirmation', async t => {
  t.mock.method(console, 'warn', () => {});
  const member = localDb.createMember({ name: '欠款确认客户', phone: '13800001001', initialBalance: '20.01' });
  await mount();
  button('扣款').click(); await nextTick();
  assert.ok(button('展开键盘'));
  assert.match(document.querySelector('.debt-warning').textContent, /新增欠款 ¥17.99/);
  assert.ok(document.querySelector('.consume-amount-debt'));
  button('核对欠款').click(); await nextTick();
  assert.equal(document.querySelector('.consume-confirm-dialog').getAttribute('role'), 'alertdialog');
  assert.equal(button('确认并记欠款').disabled, true);
  assert.equal(localDb.getMemberById(member.id).balance, 2001);
  let acknowledgement = document.querySelector('.debt-acknowledgement input');
  acknowledgement.click(); await nextTick();
  assert.equal(button('确认并记欠款').disabled, false);
  button('返回修改').click(); await nextTick();
  button('核对欠款').click(); await nextTick();
  assert.equal(document.querySelector('.debt-acknowledgement input').checked, false);
  assert.equal(button('确认并记欠款').disabled, true);
  document.querySelector('.debt-acknowledgement input').click(); await nextTick();
  const confirm = button('确认并记欠款');
  confirm.click(); confirm.click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, -1799);
  assert.equal(localDb.getLedgers().filter(l => l.type === 'CONSUME').length, 1);
  assert.ok(document.querySelector('#feedback-title').textContent.includes('已记录欠款'));
  assert.ok(document.querySelector('.feedback-amount .balance-debt').textContent.includes('17.99'));
  button('知道了').click(); await nextTick();
  button('扣款').click(); await nextTick();
  assert.match(document.querySelector('.debt-warning').textContent, /新增欠款 ¥38.00/);
  assert.match(document.querySelector('.debt-warning').textContent, /累计欠款 ¥55.99/);
});

test('a changed customer balance forces renewed debt acknowledgement before saving the deduction', async t => {
  t.mock.method(console, 'warn', () => {});
  const member = localDb.createMember({ name: '余额变化客户', phone: '13800001001', initialBalance: 20 });
  await mount(); button('扣款').click(); await nextTick();
  button('核对欠款').click(); await nextTick();
  document.querySelector('.debt-acknowledgement input').click(); await nextTick();
  localDb.recharge({ memberId: member.id, actualPay: 5 });
  button('确认并记欠款').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, 2500);
  assert.equal(document.querySelector('.debt-acknowledgement input').checked, false);
  assert.ok(document.querySelector('.consume-confirm-dialog').textContent.includes('13.00'));
  assert.ok(document.body.textContent.includes('余额已变化'));
});

test('repayment from the consume drawer previews the remaining debt and produces a clear receipt', async t => {
  t.mock.method(console, 'warn', () => {});
  const member = localDb.createMember({ name: '还款客户', phone: '13800001001' });
  localDb.consume({ memberId: member.id, amount: 38, allowDebt: true });
  await mount(); button('扣款').click(); await nextTick();
  button('先充值 / 还款').click(); await nextTick();
  assert.ok(document.querySelector('.recharge-plans'));
  const inputs = [...document.querySelectorAll('input[type="number"]')];
  inputs[0].value = '10'; inputs[1].value = '0';
  inputs.forEach(input => input.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
  await nextTick(); button('核对充值信息').click(); await nextTick();
  assert.match(document.querySelector('.recharge-debt-preview').textContent, /抵扣欠款 ¥10.00/);
  assert.match(document.querySelector('.recharge-debt-preview').textContent, /仍欠款 ¥28.00/);
  button('确认充值').click(); await nextTick();
  assert.equal(localDb.getMemberById(member.id).balance, -2800);
  assert.ok(document.body.textContent.includes('本次抵扣欠款：¥10.00'));
  assert.ok(document.body.textContent.includes('当前仍欠款：¥28.00'));
});

test('confirmation inquiry modal renders friendly Chinese buttons, handles cancel, back button and accept', async t => {
  await mount();
  await settings('services');
  const serviceCountBefore = localDb.getServices().length;
  const deleteBtn = button('删除');
  assert.ok(deleteBtn);
  deleteBtn.click();
  await nextTick();

  // Confirmation modal should appear
  const confirmDialog = document.querySelector('.confirm-dialog');
  assert.ok(confirmDialog, 'confirm modal must be visible');
  assert.ok(confirmDialog.textContent.includes('删除服务确认'));
  assert.ok(confirmDialog.textContent.includes('确定要删除该服务项目吗'));

  // Verify friendly Chinese buttons (no English OK / Cancel)
  const cancelBtn = [...confirmDialog.querySelectorAll('button')].find(b => b.textContent.trim() === '取消');
  const submitBtn = [...confirmDialog.querySelectorAll('button')].find(b => b.textContent.trim() === '确认删除');
  assert.ok(cancelBtn, 'Cancel button in Chinese');
  assert.ok(submitBtn, 'Submit button in Chinese');

  // Cancel action does not delete
  cancelBtn.click();
  await nextTick();
  assert.equal(document.querySelector('.confirm-dialog'), null);
  assert.equal(localDb.getServices().length, serviceCountBefore);

  // Trigger again and test accept
  button('删除').click();
  await nextTick();
  // Test Escape / Back button dismissal
  assert.ok(document.querySelector('.confirm-dialog'));
  window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  await nextTick();
  assert.equal(document.querySelector('.confirm-dialog'), null);
  assert.equal(localDb.getServices().length, serviceCountBefore);

  // Trigger again and test accept
  button('删除').click();
  await nextTick();
  const submitBtn2 = [...document.querySelector('.confirm-dialog').querySelectorAll('button')].find(b => b.textContent.trim() === '确认删除');
  submitBtn2.click();
  await nextTick();
  assert.equal(document.querySelector('.confirm-dialog'), null);
  assert.equal(localDb.getServices().length, serviceCountBefore - 1);
});
