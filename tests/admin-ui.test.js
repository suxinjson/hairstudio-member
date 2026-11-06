import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'location']) globalThis[key] = dom.window[key];
globalThis.localStorage = dom.window.localStorage;
globalThis.alert = () => {}; globalThis.confirm = () => true;
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'member-admin-ui-test-'));
const { parse, compileScript } = await import('@vue/compiler-sfc');
const cache = new Map();
async function compile(sourceUrl) {
  const key = String(sourceUrl);
  if (cache.has(key)) return cache.get(key);
  const output = pathToFileURL(join(directory, cache.size + '.mjs')).href; cache.set(key, output);
  const { descriptor } = parse(await readFile(new URL(key), 'utf8'));
  let script = compileScript(descriptor, { id: output, inlineTemplate: true }).content;
  for (const match of [...script.matchAll(/from (['"])([^'"]+)\1/g)]) {
    const target = match[2].endsWith('.vue') ? await compile(new URL(match[2], key)) : match[2].startsWith('.') ? new URL(match[2], key).href : pathToFileURL(require.resolve(match[2])).href;
    script = script.replace(match[0], 'from ' + match[1] + target + match[1]);
  }
  await writeFile(new URL(output), script); return output;
}
const { default: App } = await import(await compile(new URL('../admin/src/App.vue', import.meta.url)));
const { default: Members } = await import(await compile(new URL('../admin/src/views/MembersView.vue', import.meta.url)));
const { default: Ledgers } = await import(await compile(new URL('../admin/src/views/LedgersView.vue', import.meta.url)));
const { default: Services } = await import(await compile(new URL('../admin/src/views/ServicesView.vue', import.meta.url)));
const { default: ImportExport } = await import(await compile(new URL('../admin/src/views/ImportExportView.vue', import.meta.url)));
const { createApp, nextTick, ref, h } = await import('vue');
const { adminApi } = await import('../admin/src/api/client.js');
const { DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } = await import('../src/storage.js');
const { integrity } = await import('../server/security.js');
const { ADMIN_IDLE_TIMEOUT_MS } = await import('../admin/src/api/client.js');
let app, data;
const owner = { id: 'owner-A', storeId: 'store-A', username: 'owner-A', displayName: '门店 A', role: 'owner' };
const flush = async () => { for (let i = 0; i < 6; i++) await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick(); };
function button(text) { const buttons = [...document.querySelectorAll('button')]; const found = buttons.find(element => element.textContent.trim() === text) || buttons.find(element => element.textContent.includes(text)); assert.ok(found, 'Missing button ' + text); return found; }
async function input(selector, value) { const element = document.querySelector(selector); assert.ok(element); element.value = value; element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await nextTick(); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount(component = App, props = {}) { app = createApp(component, props); app.mount('#app'); await flush(); }

beforeEach(t => {
  localStorage.clear(); document.body.innerHTML = '<div id="app"></div>';
  adminApi.clearSession(); adminApi.saveSession({ accessToken: 'access', refreshToken: 'refresh', user: owner }, false);
  adminApi.accountStatus.value = 'synced'; adminApi.accountError.value = '';
  data = { members: [{ id: 'member-A', name: 'PRIVATE_STORE_A_CUSTOMER', phone: '13800001111', balance: 10000,
    total_recharge: 10000, total_consume: 0, notes: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }],
    ledgers: [], services: DEFAULT_SERVICES, rechargePlans: DEFAULT_RECHARGE_PLANS };
  adminApi.accountData.value = data;
  t.mock.method(adminApi, 'getAccount', async () => ({ data, revision: 1, integrity: integrity(data) }));
});
afterEach(() => { app?.unmount(); app = null; });

test('the pending operation resolution action confirms, waits, and clears the blocked workspace', async t => {
  const pending = deferred(); let calls = 0;
  const pendingKey = adminApi.scopedKey('pending');
  localStorage.setItem(pendingKey, JSON.stringify({ operations: [{ id: 'original' }], uncertain: true }));
  adminApi.readPending();
  t.mock.method(adminApi, 'resolvePending', async () => {
    calls++; const result = await pending.promise;
    localStorage.removeItem(pendingKey); adminApi.readPending();
    return result;
  });
  await mount();
  button('核对并取消未入账操作').click(); await flush();
  assert.equal(calls, 1); assert.equal(button('核对并取消未入账操作').disabled, true);
  pending.resolve({ resolved: [{ id: 'original', status: 'cancelled' }] }); await flush();
  assert.equal(document.body.textContent.includes('核对并取消未入账操作'), false);
});
after(async () => {
  adminApi.dispose(); dom.window.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

test('account invalidation removes every old customer and a failed other-store login cannot display stale data or a success badge', async t => {
  await mount(); button('会员档案').click(); await nextTick();
  assert.ok(document.body.textContent.includes('PRIVATE_STORE_A_CUSTOMER'));
  adminApi.clearSession(); await nextTick();
  t.mock.method(adminApi, 'getAccount', async () => { adminApi.accountStatus.value = 'error'; adminApi.accountError.value = '网络不可用'; throw new Error('offline'); });
  t.mock.method(adminApi, 'login', async () => { adminApi.saveSession({ accessToken: 'new', refreshToken: 'new-refresh', user: { ...owner, id: 'owner-B', storeId: 'store-B' } }); return {}; });
  await input('input[type="text"]', 'owner-B'); await input('input[type="password"]', 'Correct-Password-2026!');
  button('登录').click(); await flush();
  assert.equal(adminApi.user.value.storeId, 'store-B');
  assert.equal(document.body.textContent.includes('PRIVATE_STORE_A_CUSTOMER'), false);
  assert.equal(document.body.textContent.includes('云端账本已同步'), false);
  assert.ok(document.body.textContent.includes('网络不可用'));
});

test('recharge keeps its form and prevents a second submission until the server confirms; errors preserve inputs', async () => {
  const pending = deferred(); let calls = 0;
  await mount(Members, { members: data.members, submitOperations: async () => { calls++; return pending.promise; } });
  button('充值').click(); await nextTick(); await input('input[placeholder="请输入充值金额"]', '50.01');
  button('确认充值').click(); await nextTick();
  assert.ok(document.querySelector('input[placeholder="请输入充值金额"]'));
  assert.equal(button('入账中').disabled, true); button('入账中').click(); assert.equal(calls, 1);
  pending.reject(new Error('offline')); await flush();
  assert.equal(document.querySelector('input[placeholder="请输入充值金额"]').value, '50.01');
  assert.equal(button('确认充值').disabled, false);
});

test('service save waits for confirmation and keeps the editor open while saving', async () => {
  const pending = deferred(); let calls = 0;
  await mount(Services, { services: data.services, rechargePlans: data.rechargePlans, submitOperations: async () => { calls++; return pending.promise; } });
  button('添加服务项目').click(); await nextTick(); await input('input[type="text"]', '新服务'); await input('input[type="number"]', '30');
  button('保存项目').click(); await nextTick(); assert.equal(button('保存项目').disabled, true); assert.equal(calls, 1);
  pending.resolve({ success: true }); await flush(); assert.equal(document.querySelector('input[type="text"]'), null);
});

test('admin recharge plans follow the current gift policy and update when it changes', async () => {
  await mount(); button('服务与卡项').click(); await nextTick();
  assert.ok(document.body.textContent.includes('送 ¥50.00'));
  assert.equal(document.body.textContent.includes('送 ¥80'), false);
  adminApi.accountData.value = { ...data, rechargeSettings: { giftEnabled: true, giftRate: 12.5 } };
  await nextTick();
  assert.ok(document.body.textContent.includes('送 ¥62.50'));
  adminApi.accountData.value = { ...data, rechargeSettings: { giftEnabled: false, giftRate: 12.5 } };
  await nextTick();
  assert.ok(document.body.textContent.includes('充值赠送已关闭'));
  assert.equal(document.body.textContent.includes('送 ¥'), false);
});

test('refund debt is displayed and requires an explicit checkbox before an operation can be submitted', async () => {
  data.members[0].balance = 2000;
  const ledger = { id: 'ledger-A', memberId: 'member-A', memberName: data.members[0].name, type: 'RECHARGE', changeAmount: 10000,
    balanceBefore: 0, balanceAfter: 10000, created_at: '2026-01-01T00:00:00.000Z' };
  let submitted; const pending = deferred();
  await mount(Ledgers, { members: data.members, ledgers: [ledger], submitOperations: async operations => { submitted = operations; return pending.promise; } });
  button('撤单冲正').click(); await nextTick();
  assert.ok(document.body.textContent.includes('80.00 元欠款')); assert.equal(button('确认撤单冲正').disabled, true);
  const checkbox = document.querySelector('input[type="checkbox"]'); checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
  button('确认撤单冲正').click(); await flush();
  assert.equal(submitted[0].args[2], true); assert.equal(button('冲正处理中').disabled, true);
  pending.resolve({ success: true }); await flush(); assert.equal(document.body.textContent.includes('确定要撤销冲正此单吗'), false);
});

test('a changed balance during refund verification resets debt approval and submits nothing', async t => {
  const ledger = { id: 'ledger-A', memberId: 'member-A', memberName: data.members[0].name, type: 'RECHARGE', changeAmount: 5000, balanceAfter: 5000 };
  let calls = 0;
  t.mock.method(adminApi, 'getAccount', async () => ({ data: { ...data, members: [{ ...data.members[0], balance: 1000 }] } }));
  await mount(Ledgers, { members: data.members, ledgers: [ledger], submitOperations: async () => { calls++; } });
  button('撤单冲正').click(); await nextTick(); button('确认撤单冲正').click(); await flush();
  assert.equal(calls, 0); assert.ok(document.body.textContent.includes('会员余额已变化'));
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false); assert.equal(button('确认撤单冲正').disabled, true);
});

test('import requires separate column and debt confirmations before sending a negative balance task', async t => {
  let submitted;
  t.mock.method(adminApi, 'executeBatchImport', async (items, strategy, progress, options) => { submitted = { items, options }; return { count: 1 }; });
  await mount(ImportExport, { members: data.members, ledgers: [] });
  const csv = new TextEncoder().encode('会员姓名,手机号码,本金余额,赠金余额\n新欠款,13900001111,-100.01,0');
  const picker = document.querySelector('input[type="file"]');
  Object.defineProperty(picker, 'files', { value: [{ name: 'debt.csv', size: csv.length, arrayBuffer: async () => csv.buffer }], configurable: true });
  picker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await flush();
  assert.equal(button('开始零损数据预检').disabled, true);
  const mappingCheckbox = document.querySelector('input[type="checkbox"]');
  mappingCheckbox.checked = true; mappingCheckbox.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
  button('开始零损数据预检').click(); await nextTick();
  assert.equal(button('确认入库至系统账本').disabled, true);
  const debtCheckbox = [...document.querySelectorAll('label')].find(label => label.textContent.includes('负余额记录')).querySelector('input');
  debtCheckbox.checked = true; debtCheckbox.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
  button('确认入库至系统账本').click(); await flush();
  assert.equal(submitted.items[0].data.balanceCents, -10001); assert.equal(submitted.options.allowDebt, true);
});

test('legacy string tags render all members and populate the editor without throwing', async () => {
  data.members[0].tags = 'VIP';
  const members = [...data.members, { ...data.members[0], id: 'member-B', name: '数组标签会员', tags: ['常客', '年卡'] }];
  await mount(Members, { members, submitOperations: async () => {} });
  assert.equal(document.querySelectorAll('tbody tr').length, 2);
  assert.ok(document.querySelector('tbody').textContent.includes('VIP'));
  assert.ok(document.querySelector('tbody').textContent.includes('常客、年卡'));
  const edit = [...document.querySelector('tbody tr').querySelectorAll('button')].find(element => element.title === '修改资料' || element.textContent.includes('修改'));
  assert.ok(edit, 'Missing profile edit action'); edit.click(); await nextTick();
  assert.equal(document.querySelector('input[placeholder="如：VIP、常客、烫染年卡"]').value, 'VIP');
});

test('manual header selection resets mapping approval and precheck and reports physical file rows', async () => {
  await mount(ImportExport, { members: data.members, ledgers: [] });
  const csv = new TextEncoder().encode('梦飞空间会员批量导入\n会员姓名,手机号码,本金余额,赠金余额\n\n坏号码,123,10,0\n会员姓名,手机号码,本金余额,赠金余额\n新客户,13900001111,20,0');
  const picker = document.querySelector('input[type="file"]');
  Object.defineProperty(picker, 'files', { value: [{ name: 'title.csv', size: csv.length, arrayBuffer: async () => csv.buffer }], configurable: true });
  picker.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await flush();
  const selector = document.querySelector('select[aria-label="表头所在行"]');
  assert.ok(selector); assert.equal(selector.value, '1');
  const approve = document.querySelector('input[type="checkbox"]');
  approve.checked = true; approve.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
  button('开始零损数据预检').click(); await nextTick();
  assert.ok(document.querySelector('tbody').textContent.includes('4'));
  assert.ok(document.querySelector('tbody').textContent.includes('坏号码'));
  selector.value = '4'; selector.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
  assert.equal(document.querySelector('input[type="checkbox"]').checked, false);
  assert.equal(button('开始零损数据预检').disabled, true);
  assert.equal(document.querySelector('tbody'), null);
  const freshApprove = document.querySelector('input[type="checkbox"]');
  freshApprove.checked = true; freshApprove.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
  button('开始零损数据预检').click(); await nextTick();
  assert.equal(document.querySelectorAll('tbody tr').length, 1);
  assert.ok(document.querySelector('tbody').textContent.includes('6'));
  assert.ok(document.querySelector('tbody').textContent.includes('新客户'));
});

for (const { view, prop, filter } of [
  { view: Members, prop: 'members', filter: '低余额' },
  { view: Ledgers, prop: 'ledgers', filter: '消费扣款' }
]) {
  test(`${prop} reset pagination for search, filters and page size and clamp after data shrinks`, async () => {
    const rows = ref(Array.from({ length: 51 }, (_, i) => ({ ...data.members[0], id: 'row-' + i,
      name: '客户' + i, memberName: '客户' + i, balance: i === 0 ? 1000 : 10000,
      type: i === 0 ? 'CONSUME' : 'RECHARGE', changeAmount: i === 0 ? -1000 : 10000,
      balanceAfter: 10000, memberPhone: '13800001111' })));
    await mount({ setup: () => () => h(view, { [prop]: rows.value, submitOperations: async () => {} }) });
    button('下一页').click(); await nextTick(); button('下一页').click(); await nextTick();
    assert.ok(document.body.textContent.includes('第 3 / 3 页'));
    await input('input[type="text"]', '客户0');
    assert.equal(document.querySelectorAll('tbody tr').length, 1);
    assert.ok(document.querySelector('tbody').textContent.includes('客户0'));
    assert.ok(document.body.textContent.includes('第 1 / 1 页'));
    await input('input[type="text"]', '');
    button('下一页').click(); await nextTick(); button(filter).click(); await nextTick();
    assert.equal(document.querySelectorAll('tbody tr').length, 1);
    assert.ok(document.body.textContent.includes('第 1 / 1 页'));
    button(prop === 'members' ? '全部会员' : '全部流水').click(); await nextTick();
    button('下一页').click(); await nextTick(); button('下一页').click(); await nextTick();
    const select = document.querySelector('select'); select.value = '50';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
    assert.equal(document.querySelectorAll('tbody tr').length, 50);
    assert.ok(document.body.textContent.includes('第 1 / 2 页'));
    select.value = '20'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await nextTick();
    button('下一页').click(); await nextTick(); button('下一页').click(); await nextTick();
    rows.value = rows.value.slice(0, 21); await nextTick();
    assert.ok(document.body.textContent.includes('第 2 / 2 页'));
    assert.equal(document.querySelectorAll('tbody tr').length, 1);
    rows.value = []; await nextTick();
    assert.ok(document.body.textContent.includes('第 1 / 1 页'));
  });
}

test('admin inactivity locks at the saved deadline and removes its timer on unmount', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  adminApi.saveSession({ accessToken: 'access', refreshToken: 'refresh', user: owner }, false, { resetIdle: true });
  app = createApp(App); app.mount('#app'); await nextTick();
  const deadline = adminApi.idleExpiresAt.value;
  t.mock.timers.tick(ADMIN_IDLE_TIMEOUT_MS - 1); await nextTick();
  assert.equal(adminApi.isLocked.value, false);
  t.mock.timers.tick(1); await nextTick();
  assert.equal(adminApi.isLocked.value, true);
  assert.ok(button('解锁工作台'));
  window.dispatchEvent(new dom.window.Event('keydown')); await nextTick();
  assert.equal(adminApi.idleExpiresAt.value, deadline);
  const read = t.mock.method(adminApi, 'restoreSession');
  app.unmount(); app = null;
  t.mock.timers.tick(ADMIN_IDLE_TIMEOUT_MS);
  window.dispatchEvent(new dom.window.Event('focus'));
  assert.equal(read.mock.callCount(), 0);
});

for (const event of ['focus', 'visibilitychange']) {
  test(`admin ${event} checks expiry before any activity can renew a suspended session`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    app = createApp(App); app.mount('#app'); await nextTick();
    const deadline = adminApi.idleExpiresAt.value;
    t.mock.timers.setTime(deadline + 1);
    (event === 'focus' ? window : document).dispatchEvent(new dom.window.Event(event));
    await nextTick();
    assert.equal(adminApi.isLocked.value, true);
    window.dispatchEvent(new dom.window.Event('mousemove')); await nextTick();
    assert.equal(adminApi.isLocked.value, true);
    assert.equal(adminApi.idleExpiresAt.value, deadline);
  });
}
