import test, { before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { browserLocks, vueUi } from './helpers/vue-ui.mjs';
import { buildOpeningProjection } from '../tools/relational-import.mjs';

const password = 'Synthetic-UI-2026!';
const locks = browserLocks();
let ui, Cashier, Merchant, api, MerchantSessionClient, sessionKey, accessTimeout, database, service, origin, server;
let requestHandler, requests, storeA, storeB;

before(async t => {
  ui = await vueUi(t);
  ({ ADMIN_SESSION_KEY: sessionKey, ADMIN_IDLE_TIMEOUT_MS: accessTimeout, MerchantSessionClient } = await import('../admin/src/api/merchant-session.js'));
  ({ adminApi: api } = await import('../admin/src/api/session.js'));
  api.lockOptions = { locks };
  Cashier = await ui.component(new URL('../src/OnlineCashier.vue', import.meta.url));
  Merchant = await ui.component(new URL('../admin/src/App.vue', import.meta.url));
  const { relationalTestDatabase } = await import('../server/tests/helpers/relational-database.js');
  const { createService } = await import('../server/tests/helpers/licensed-service.js');
  const { createApi } = await import('../server/http.js');
  database = await relationalTestDatabase();
  service = createService(database.pool);
  server = createApi({ service, pool: database.pool, production: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await database?.close();
});

async function seed(username, name) {
  await service.createOwner({ username, password });
  const session = await service.login({ username, password, deviceId: randomUUID() });
  const actor = await service.authenticate(session.accessToken), book = await service.relational.getBook(actor);
  await service.relational.importOpeningBalances(actor, {
    ledgerEpoch: book.ledgerEpoch, batchId: randomUUID(), sourceDigest: 'a'.repeat(64), expectedCount: 1,
    members: [{ id: 'ui-member', name, balanceCents: '1234' }],
  });
  return { username, name, actor };
}

const direct = (path, options) => fetch(origin + path, options);
async function testedFetch(path, options) {
  requests.push({ path, method: options.method ?? 'GET', body: options.body });
  return requestHandler(path, options);
}

beforeEach(async () => {
  localStorage.removeItem(sessionKey);
  api.restoreSession();
  for (const key of Object.keys(localStorage)) if (key.startsWith('hairstudio_v2_pending:')) localStorage.removeItem(key);
  for (const key of Object.keys(localStorage)) if (key.startsWith('hairstudio_v2_opening:')) localStorage.removeItem(key);
  await database.pool.query('TRUNCATE stores,login_limits RESTART IDENTITY CASCADE');
  storeA = await seed('ui-owner-a', '甲店合成会员');
  storeB = await seed('ui-owner-b', '乙店合成会员');
  requestHandler = direct; requests = [];
  api.requestFetch = testedFetch;
});
afterEach(() => ui.unmount());

async function waitFor(check) {
  for (let elapsed = 0; elapsed < 300; elapsed++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), document.body.textContent.replace(/\s+/g, ' ').trim());
}
const has = text => document.querySelector('#app').textContent.includes(text);
function tab(t) {
  const client = new MerchantSessionClient({ storage: localStorage, fetch: testedFetch, locks, eventTarget: null });
  t.after(() => client.dispose());
  return client;
}
function shareSessionEvent() { window.dispatchEvent(new window.StorageEvent('storage', { key: sessionKey })); }
async function cashierLogin(username, secret = password) {
  await ui.input('input[autocomplete="username"]', username);
  await ui.input('input[type="password"]', secret);
  document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
async function reviewRecharge(amount) {
  ui.button(storeA.name).click(); await waitFor(() => has('收起档案'));
  ui.button('充值').click(); await waitFor(() => has('实收（元）'));
  await ui.input('input[inputmode="decimal"]', amount);
  document.querySelector('form:has(input[inputmode="decimal"])').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await ui.nextTick();
  return ui.button('确认充值');
}
async function snapshot(store = storeA) {
  const ledger = service.relational;
  return { member: await ledger.getMember(store.actor, 'ui-member'), entries: (await ledger.listLedger(store.actor)).items };
}

test('cashier uses authenticated v2 pages and recovers from a failed handshake without showing the previous v1 cache', async t => {
  const retiredKey = 'hairstudio_members_v1';
  localStorage.setItem(retiredKey, '[{"name":"旧账本敏感数据"}]');
  t.after(() => localStorage.removeItem(retiredKey));
  requestHandler = async (path, options) => path === '/api/v2/book'
    ? Response.json({ error: '隔离数据库不可用' }, { status: 503 }) : direct(path, options);
  await ui.mount(Cashier);
  assert.ok(has('登录门店账号'));
  assert.equal(requests.length, 0);
  await cashierLogin(storeA.username);
  await waitFor(() => has('隔离数据库不可用'));
  assert.equal(has(storeA.name), false);
  assert.equal(has('旧账本敏感数据'), false);
  assert.equal(has('新增会员'), false);
  requestHandler = direct;
  ui.button('重试连接').click();
  await waitFor(() => has(storeA.name));
  assert.ok(has('¥12.34'));
  assert.equal(Object.values(localStorage).some(value => value.includes(storeA.name)), false);
  assert.ok(requests.some(({ path }) => path.startsWith('/api/v2/members?')));
  assert.equal(requests.some(({ path }) => /^\/api\/v1\/(?:account|sync)(?:[/?]|$)/.test(path)), false);
});

test('a posted recharge with a lost response keeps the original number across reload and recovers it without another write', async () => {
  await api.login(storeA.username, password);
  await ui.mount(Cashier); await waitFor(() => has(storeA.name));
  let release, received;
  const committed = new Promise(resolve => { received = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  requestHandler = async (path, options) => {
    const response = await direct(path, options);
    if (path === '/api/v2/commands' && options.method === 'POST' && response.ok) {
      received(); await pause; throw new TypeError('隔离测试故意丢弃已提交回执');
    }
    return response;
  };
  const confirmation = await reviewRecharge('1.01'); confirmation.click(); confirmation.click();
  try {
    await Promise.race([committed, delay(3000).then(() => { throw new Error('未提交充值'); })]);
    assert.equal(confirmation.disabled, true);
    assert.equal(has('已确认原单'), false);
  } finally { release(); }
  await waitFor(() => has('有一笔操作待确认') && has('故意丢弃'));
  const sent = requests.filter(({ path, method }) => path === '/api/v2/commands' && method === 'POST');
  assert.equal(sent.length, 1);
  const original = JSON.parse(sent[0].body);
  assert.equal(original.actualPayCents, '101');
  assert.equal(original.giftCents, '10');
  assert.ok(has(original.id));
  await ui.mount(Cashier); await waitFor(() => has(original.id));
  assert.equal(ui.button('新增会员').disabled, true);
  ui.button('按原号核对').click(); await waitFor(() => has('已取回原回执'));
  assert.equal(has('有一笔操作待确认'), false);
  assert.equal(requests.filter(({ path, method }) => path === '/api/v2/commands' && method === 'POST').length, 1);
  assert.equal((await snapshot()).member.balanceCents, '1345');
  assert.deepEqual((await snapshot()).entries.map(row => row.id), [original.id]);
});

test('a profile change as the reviewed recharge arrives rejects the old confirmation before any write', async () => {
  await api.login(storeA.username, password);
  const book = await service.relational.getBook(storeA.actor);
  await ui.mount(Cashier); await waitFor(() => has(storeA.name));
  let changed = false;
  requestHandler = async (path, options) => {
    if (!changed && path === '/api/v2/commands' && options.method === 'POST') {
      changed = true;
      await service.relational.updateMember(storeA.actor, 'ui-member', { name: '核对后的合成姓名', phone: '001234', notes: '新档案提示', expectedVersion: '0' }, { ...book, id: randomUUID() });
    }
    return direct(path, options);
  };
  (await reviewRecharge('1.01')).click();
  await waitFor(() => has('资料或余额已变化') && has('手机尾号 1234') && has('新档案提示'));
  assert.equal((await snapshot()).entries.length, 0);
  assert.equal((await snapshot()).member.balanceCents, '1234');
  assert.ok(has('原操作已拒绝'));
  assert.ok(has('原请求没有入账'));
  assert.equal(ui.button('核对金额').disabled, true);
  ui.button('确认结束').click(); await waitFor(() => !ui.button('核对金额').disabled);
  const review = ui.button('核对金额');
  assert.equal(review.form.querySelector('input[inputmode=decimal]').value, '1.01');
  review.click(); await ui.nextTick();
  ui.button('确认充值').click(); await waitFor(() => has('已确认原单'));
  assert.equal((await snapshot()).member.balanceCents, '1345');
  const posts = requests.filter(({ path }) => path === '/api/v2/commands').map(({ body }) => JSON.parse(body));
  assert.deepEqual(posts.map(row => row.expectedProfileVersion), ['0', '1']);
  assert.notEqual(posts[0].id, posts[1].id);
});

test('blank-phone registration preserves input and makes the operator review renewed same-name details', async () => {
  await api.login(storeA.username, password);
  await ui.mount(Cashier); await waitFor(() => has(storeA.name));
  ui.button('新增会员').click(); await ui.nextTick();
  await ui.input('form.book-stack input[maxlength="128"]', storeA.name);
  await ui.input('form.book-stack textarea', '新档案区分备注');
  ui.button('保存档案').click(); await waitFor(() => has('有其他同名的在用会员'));
  const book = await service.relational.getBook(storeA.actor);
  await service.relational.updateMember(storeA.actor, 'ui-member', { name: storeA.name, notes: '刚同步的原会员备注', expectedVersion: '0' }, { ...book, id: randomUUID() });
  assert.equal(ui.button('仍然保存').disabled, true);
  document.querySelector('form input[type=checkbox]').click(); await ui.nextTick();
  ui.button('仍然保存').click(); await waitFor(() => has('刚同步的原会员备注'));
  assert.equal(requests.filter(({ path, method }) => path === '/api/v2/tasks' && method === 'POST').length, 0);
  assert.equal(document.querySelector('form.book-stack textarea').value, '新档案区分备注');
  assert.equal(document.querySelector('form input[type=checkbox]').checked, false);
  document.querySelector('form input[type=checkbox]').click(); await ui.nextTick();
  ui.button('仍然保存').click(); await waitFor(() => has('会员档案已保存'));
  await ui.input('input[placeholder="姓名、电话或备注"]', '新档案区分备注');
  ui.button('查询').click(); await waitFor(() => has('本页 1 条') && has('新档案区分备注'));
  const rows = (await service.relational.listMembers(storeA.actor)).items;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.name === storeA.name));
  assert.deepEqual(rows.map(row => row.notes), ['刚同步的原会员备注', '新档案区分备注']);
});

test('a second tab changing store discards late member results and a locked tab never renders the book', async t => {
  await api.login(storeA.username, password);
  const other = tab(t);
  const tokenA = api.accessToken.value;
  let release, firstResponse;
  const paused = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { firstResponse = resolve; });
  requestHandler = async (path, options) => {
    if (!path.startsWith('/api/v2/members?') || options.headers.Authorization !== 'Bearer ' + tokenA) return direct(path, options);
    const response = await direct(path, options); firstResponse(); await paused; return response;
  };
  await ui.mount(Merchant); await waitFor(() => has('在线账本'));
  ui.button('会员档案').click();
  try {
    await Promise.race([received, delay(3000).then(() => { throw new Error('未读取甲店'); })]);
    await other.login(storeB.username, password); shareSessionEvent();
    await waitFor(() => has('经营大盘') && api.user.value?.storeId === storeB.actor.store_id && has('在线账本'));
    ui.button('会员档案').click(); await waitFor(() => has(storeB.name));
  } finally { release(); }
  await ui.nextTick();
  assert.equal(has(storeA.name), false);
  other.isLocked.value = true; shareSessionEvent(); await ui.nextTick();
  assert.ok(has('系统已安全锁屏'));
  assert.equal(has(storeB.name), false);
  await other.login(storeB.username, password); shareSessionEvent();
  await waitFor(() => has(storeB.name));
  assert.equal(has(storeA.name), false);
});

test('merchant reopens a captured CSV batch after the first group response is lost and resumes only the remaining row', async () => {
  await api.login(storeA.username, password);
  await ui.mount(Merchant); await waitFor(() => has('在线账本'));
  ui.button('批量资料').click(); await waitFor(() => document.querySelector('input[type="file"]')?.disabled === false);
  const input = document.querySelector('input[type="file"]');
  const csv = new Blob(['姓名,电话,备注,标签\n' + Array.from({ length: 26 }, (_, i) => '批次合成' + i + ',,样本,回归\n').join('')]);
  Object.defineProperty(input, 'files', { value: [Object.assign(csv, { name: 'synthetic-batch.csv' })] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => has('预检通过：26 行'));
  ui.button('确认捕获为暂停批次').click();
  await waitFor(() => has('已确认 0 / 26'));
  const batchId = JSON.parse(requests.find(({ path, method }) => path === '/api/v2/batches' && method === 'POST').body).id;
  const isStep = path => path.includes('/items/') || path.endsWith('/steps');
  const posted = () => requests.filter(({ path, method }) => isStep(path) && method === 'POST');
  requestHandler = async (path, options) => {
    const response = await direct(path, options);
    if (isStep(path) && options.method === 'POST' && response.ok && posted().length === 1) throw new TypeError('首组回执丢失');
    return response;
  };
  ui.button('继续原批次').click();
  await waitFor(() => has('批次保留原进度') && has('已确认 25 / 26'));
  assert.equal(posted().length, 1);
  await ui.mount(Merchant); await waitFor(() => has('在线账本'));
  ui.button('批量资料').click(); await waitFor(() => has(batchId));
  ui.button(batchId).click(); await waitFor(() => has('已确认 25 / 26'));
  ui.button('继续原批次').click(); await waitFor(() => has('已确认 26 / 26'));
  assert.equal(posted().length, 2);
  const firstIds = JSON.parse(posted()[0].body).taskIds;
  assert.equal(firstIds.length, 25);
  assert.ok(!firstIds.includes(posted()[1].path.split('/').at(-2)));
  const members = (await service.relational.listMembers(storeA.actor)).items;
  assert.deepEqual(members.filter(row => row.name.startsWith('批次')).map(row => row.balanceCents), Array(26).fill('0'));
  assert.equal((await snapshot()).entries.length, 0);
});

test('merchant opening uses a reviewed file and recovers its original 91-person receipt after reload', async () => {
  await service.createOwner({ username: 'ui-cutover-owner', password });
  await api.login('ui-cutover-owner', password);
  const owner = await service.authenticate(api.accessToken.value);
  const { projection, summary } = buildOpeningProjection(JSON.stringify({ members: Array.from({ length: 91 }, (_, i) => ({
    id: 'cutover-' + i, name: '合成结转 ' + i, phone: i === 0 ? '00111' : '', balance: i - 30
  })) }));
  const payload = JSON.stringify(projection);
  async function page() {
    await ui.mount(Merchant); await waitFor(() => has('在线账本'));
    ui.button('备份与恢复').click(); await waitFor(() => has('期初余额'));
    const panel = document.querySelector('details'); panel.open = true;
    return panel;
  }
  async function choose(panel, content) {
    const field = panel.querySelector('input[type=file]'); assert.equal(field.disabled, false);
    Object.defineProperty(field, 'files', { value: [new Blob([content])], configurable: true });
    field.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  async function confirm(panel) {
    const button = ui.button('确认导入期初'); assert.equal(button.disabled, true);
    const box = panel.querySelector('input[type=checkbox]'); box.checked = true;
    box.dispatchEvent(new window.Event('change', { bubbles: true })); await ui.nextTick();
    button.click();
  }
  let panel = await page();
  await ui.input('details input[maxlength="64"]', summary.sourceDigest);
  await ui.input('details label + label input[maxlength="64"]', summary.payloadDigest);
  const changed = structuredClone(projection); changed.members[0].balanceCents = '9999';
  await choose(panel, JSON.stringify(changed)); await waitFor(() => has('与核对的摘要不一致'));
  assert.equal(requests.some(({ path }) => path.includes('/import/openings')), false);
  await choose(panel, payload); await waitFor(() => has('合成结转 90') && has('00111'));
  assert.equal((await service.relational.listMembers(owner)).items.length, 0);
  let drop = true;
  requestHandler = async (path, options) => {
    const response = await direct(path, options);
    if (drop && path === '/api/v2/import/openings' && response.ok) { drop = false; await response.text(); throw new Error('期初回执丢失'); }
    return response;
  };
  await confirm(panel); await waitFor(() => has('期初回执丢失') && has('原批次'));
  assert.equal(Object.values(localStorage).some(value => value.includes('合成结转')), false);
  assert.equal((await service.relational.getMember(owner, 'cutover-0')).balanceCents, '-30');
  panel = await page(); assert.ok(has(projection.batchId));
  await choose(panel, payload); await waitFor(() => has('合成结转 90')); await confirm(panel);
  await waitFor(() => has('原期初批次已确认：91 人'));
  const posts = requests.filter(({ path }) => path === '/api/v2/import/openings').map(({ body }) => JSON.parse(body));
  assert.equal(posts.length, 2); assert.deepEqual(posts[0], posts[1]);
  assert.equal((await service.relational.listMembers(owner, { limit: 100 })).items.length, 91);
  assert.deepEqual((await service.relational.listLedger(owner)).items, []);
});

test('merchant batch with no phone column requires review of both spreadsheet and existing same names', async () => {
  await api.login(storeA.username, password);
  await ui.mount(Merchant); await waitFor(() => has('在线账本'));
  ui.button('批量资料').click(); await waitFor(() => document.querySelector('input[type="file"]')?.disabled === false);
  const input = document.querySelector('input[type="file"]');
  const csv = new Blob(['姓名,备注\n' + storeA.name + ',另一位同名会员\n同名合成,甲\n同名合成,乙\n']);
  Object.defineProperty(input, 'files', { value: [Object.assign(csv, { name: 'duplicate-names.csv' })] });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitFor(() => has('有 3 行未留手机号'));
  const capture = ui.button('确认捕获为暂停批次');
  const approve = async () => {
    const control = document.querySelector('input[type="checkbox"]');
    control.checked = true; control.dispatchEvent(new window.Event('change', { bubbles: true })); await ui.nextTick();
  };
  assert.equal(capture.disabled, true); await approve();
  const book = await service.relational.getBook(storeA.actor);
  await service.relational.updateMember(storeA.actor, 'ui-member', { name: storeA.name, notes: '复核期间更改', expectedVersion: '0' }, { ...book, id: randomUUID() });
  capture.click(); await waitFor(() => has('同名档案已变化'));
  assert.equal(capture.disabled, true);
  assert.ok(!requests.some(row => row.path === '/api/v2/batches' && row.method === 'POST'));
  await approve(); capture.click(); await waitFor(() => has('已确认 0 / 3'));
  ui.button('继续原批次').click(); await waitFor(() => has('已确认 3 / 3'));
  const profiles = (await service.relational.listMembers(storeA.actor)).items;
  assert.equal(profiles.length, 4);
  assert.equal(profiles.filter(row => row.name === '同名合成').length, 2);
  assert.equal(profiles.filter(row => row.balanceCents === '0').length, 3);
});

for (const event of ['timer', 'focus', 'visibilitychange']) {
  test('merchant locks on ' + event + ' and removes its listeners on unmount', async t => {
    await api.login(storeA.username, password);
    const deadline = api.idleExpiresAt.value;
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: deadline - accessTimeout });
    requestHandler = async path => path === '/api/v2/book'
      ? Response.json({ error: '测试无需读取账本' }, { status: 503 }) : assert.fail('Unexpected request ' + path);
    await ui.mount(Merchant);
    if (event === 'timer') {
      t.mock.timers.tick(accessTimeout - 1); assert.equal(api.isLocked.value, false); t.mock.timers.tick(1);
    } else {
      t.mock.timers.setTime(deadline + 1);
      (event === 'focus' ? window : document).dispatchEvent(new window.Event(event));
    }
    await ui.nextTick();
    assert.ok(has('系统已安全锁屏'));
    window.dispatchEvent(new window.Event('mousemove'));
    assert.equal(api.idleExpiresAt.value, deadline);
    ui.unmount();
    const read = t.mock.method(api, 'restoreSession');
    t.mock.timers.tick(accessTimeout); window.dispatchEvent(new window.Event('focus'));
    assert.equal(read.mock.callCount(), 0);
  });
}
