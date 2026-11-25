import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { vueUi, browserLocks } from '../tests/helpers/vue-ui.mjs';

// Regression checks exercise the actual Vue components and service boundaries
// with synthetic data. The original defect probes remain in output/.
const bridge = new URL('../tests/helpers/native-cashier-bridge.mjs', import.meta.url).href;
const nativeKey = Symbol.for('member.native-ui-fixture');
let ui, Sale, Members, Cashier, NativeCashier, Reports, Ledger, PasswordField, reactive, ref, h;
const epoch = '00000000-0000-4000-8000-000000000101';
const configuration = { version: '0', services: [], rechargePlans: [], rechargeSettings: { giftEnabled: false, giftRateBasisPoints: 0 } };
const member = (id = 'audit-member', name = '审查合成会员') => ({ id, name, phone: '', notes: '', tags: [], balanceCents: '500', version: '0', accountVersion: '0', archivedAt: null, createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z' });
const scope = { storeId: 'audit-store', actorId: 'audit-owner', deviceId: 'audit-device-0001', ledgerEpoch: epoch };
let posts, rows, readOverride, workspace;

before(async t => {
  ui = await vueUi(t, { modules: { '@capacitor/app': bridge, './relational-native-session.js': bridge, './relational-native-workspace.js': bridge, './native-update.js': bridge } });
  ({ reactive, ref, h } = await import('vue'));
  Sale = await ui.component(new URL('../src/components/RelationalSale.vue', import.meta.url));
  Members = await ui.component(new URL('../src/components/RelationalMembers.vue', import.meta.url));
  Cashier = await ui.component(new URL('../src/OnlineCashier.vue', import.meta.url));
  NativeCashier = await ui.component(new URL('../src/NativeCashier.vue', import.meta.url));
  Reports = await ui.component(new URL('../src/components/RelationalReports.vue', import.meta.url));
  Ledger = await ui.component(new URL('../src/components/RelationalLedger.vue', import.meta.url));
  PasswordField = await ui.component(new URL('../src/components/PasswordField.vue', import.meta.url));
});
beforeEach(() => {
  localStorage.clear(); posts = []; rows = [member()]; readOverride = null;
  workspace = {
    mode: 'online', state: reactive({ book: scope, revision: 1, busy: false, pending: null, pendingError: '' }), getScope: () => scope,
    async read(method, input) {
      if (readOverride) { const result = readOverride(method, input); if (result !== undefined) return result; }
      if (method === 'listMembers') return { items: rows, nextCursor: null };
      if (method === 'getMember') return rows.find(row => row.id === input);
      if (method === 'getConfiguration') return configuration;
      if (method === 'listLedger') return { items: [], nextCursor: null };
      if (method === 'getMemberTotals') return { grossRechargeCents: '0', reversedRechargeCents: '0', netRechargeCents: '0', grossConsumptionCents: '0', reversedConsumptionCents: '0', netConsumptionCents: '0' };
      throw new Error('Unexpected audit read: ' + method);
    },
    async submit(kind, draft) {
      posts.push({ kind, draft });
      if (kind === 'task') {
        const row = { ...member(draft.memberId || 'saved-audit-member'), ...draft.data };
        rows = [...rows.filter(item => item.id !== row.id), row];
        return row;
      }
      const current = rows.find(row => row.id === draft.memberId);
      const before = BigInt(current.balanceCents);
      const delta = draft.type === 'recharge' ? BigInt(draft.actualPayCents) + BigInt(draft.giftCents || '0') : draft.type === 'consume' ? -BigInt(draft.amountCents) : -1000n;
      const version = String(BigInt(current.accountVersion) + 1n);
      current.balanceCents = String(before + delta); current.accountVersion = version;
      return { commandId: 'audit-command-0001', entryId: 'audit-command-0001', memberId: draft.memberId, type: draft.type, deltaCents: String(delta), balanceBeforeCents: String(before), balanceAfterCents: current.balanceCents, accountVersion: version, occurredAt: '2026-11-25T00:01:00.000Z' };
    }
  };
});
afterEach(async () => {
  ui.unmount(); delete globalThis[nativeKey];
  const { adminApi } = await import('../admin/src/api/session.js');
  adminApi.clearSession(); adminApi.setAutoLock(true);
});
const shown = text => document.querySelector('#app').textContent.includes(text);
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve)); await ui.nextTick();
  }
  assert.ok(check(), document.body.textContent);
}
const membersProps = extra => ({ workspace, owner: true, writable: true, cashierWritable: true, feature: () => true, ...extra });
function evidence(t, facts) { t.diagnostic(JSON.stringify(facts)); }

test('release approval requires dispatch, an explicit release, the approval variable and a main branch', async () => {
  const workflow = await readFile(new URL('../.github/workflows/build-apk.yml', import.meta.url), 'utf8');
  const expression = workflow.match(/RELEASE_APPROVED: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(expression);
  const approved = new Function('github', 'inputs', 'vars', 'return Boolean(' + expression + ')');
  for (const event_name of ['push', 'workflow_dispatch'])
    for (const ref of ['refs/heads/main', 'refs/heads/master', 'refs/heads/feature'])
      for (const release of [undefined, false, true])
        for (const approval of [undefined, 'false', 'true']) {
          assert.equal(approved({ event_name, ref }, { release }, { RELATIONAL_RELEASE_APPROVED: approval }),
            event_name === 'workflow_dispatch' && release === true && approval === 'true' && ref !== 'refs/heads/feature',
            JSON.stringify({ event_name, ref, release, approval }));
        }
});

test('R01: insufficient-balance consumption requires fresh explicit consent before submitting', async t => {
  await ui.mount(Sale, { workspace, scope, type: 'consume', member: member(), configuration });
  ui.button('1').click(); await ui.nextTick(); ui.button('0').click(); await ui.nextTick();
  const confirm = document.querySelector('.keypad-confirm');
  assert.ok(confirm.textContent.includes('核对欠款')); assert.equal(confirm.disabled, false);
  confirm.click(); await ui.nextTick();
  assert.ok(document.querySelector('.feedback-dialog'));
  assert.ok(shown('交易后累计欠款'));
  assert.ok(document.querySelector('.feedback-amount').textContent.includes('5.00'));
  let box = document.querySelector('input[type=checkbox]');
  assert.ok(box); assert.equal(box.checked, false);
  assert.equal(ui.button('确认扣款').disabled, true);
  ui.button('确认扣款').dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true }));
  await ui.nextTick();
  assert.equal(posts.length, 0);
  box.click(); await ui.nextTick();
  ui.button('返回修改').click(); await ui.nextTick();
  document.querySelector('.keypad-confirm').click(); await ui.nextTick();
  box = document.querySelector('input[type=checkbox]');
  assert.equal(box.checked, false); assert.equal(ui.button('确认扣款').disabled, true);
  box.click(); await ui.nextTick(); ui.button('确认扣款').click();
  await until(() => posts.length === 1);
  assert.equal(posts[0].draft.allowDebt, true);
  assert.equal(posts[0].draft.amountCents, '1000');
  evidence(t, { balanceCents: '500', attemptedCents: '1000', freshConsentRequired: true, posted: posts.length });
});

test('R02: a recharge reversal producing debt previews its exact amount and requires consent', async t => {
  rows[0].balanceCents = '0';
  await ui.mount(Sale, { workspace, scope, type: 'reverse', member: { ...member(), balanceCents: '0' }, configuration, entry: { id: 'audit-recharge', type: 'recharge', deltaCents: '1000' } });
  ui.button('核对冲正').click(); await ui.nextTick();
  const { createReversal } = await import('../src/ledger-domain.js');
  assert.throws(() => createReversal({ originalKind: 'recharge', originalDeltaCents: '1000', currentBalanceCents: '0', allowDebt: false }), /撤销后会形成欠款/);
  assert.ok(document.querySelector('.feedback-dialog'));
  const box = document.querySelector('input[type=checkbox]');
  assert.ok(box); assert.equal(box.checked, false);
  assert.ok(shown('-10.00')); assert.equal(ui.button('确认冲正').disabled, true);
  assert.equal(posts.length, 0);
  box.click(); await ui.nextTick(); ui.button('确认冲正').click();
  await until(() => posts.length === 1);
  assert.equal(posts[0].draft.allowDebt, true);
  assert.equal(posts[0].draft.originalEntryId, 'audit-recharge');
  evidence(t, { originalRechargeCents: '1000', currentBalanceCents: '0', consentRequired: true, posted: posts.length });
});

test('R03: mounted sale completion broadcasts with the result, draft and member', async t => {
  const { announceRelationalSale } = await import('../src/relational-presentation.js');
  let supplied = null, thrown = '', broadcasts = 0;
  const player = { broadcast() { broadcasts++; } };
  await ui.mount(Members, membersProps({ announce: (...args) => {
    supplied = args.length;
    try { return announceRelationalSale(player, ...args); } catch (error) { thrown = error.message; throw error; }
  } }));
  await until(() => shown(member().name)); ui.button(member().name).click(); await until(() => shown('收起档案'));
  ui.button('充值').click(); await ui.nextTick(); await until(() => document.querySelector('input[inputmode=decimal]'));
  await ui.input('input[inputmode=decimal]', '1'); ui.button('核对金额').click(); await ui.nextTick();
  ui.button('确认充值').click(); await until(() => shown('已确认原单'));
  assert.equal(posts.length, 1); assert.equal(supplied, 3); assert.equal(broadcasts, 1); assert.equal(thrown, '');
  evidence(t, { posted: posts.length, suppliedArguments: supplied, expectedArguments: 3, broadcasts, error: thrown });
});

test('R04: duplicate-name registration blocks unchecked submissions and accepts checked confirmation', async t => {
  readOverride = (method, input) => method === 'listMembers' && input.sameName ? { items: [member('existing-audit-member', '审查同名会员')], nextCursor: null } : undefined;
  await ui.mount(Members, membersProps());
  document.querySelector('#app').__vue_app__._instance.exposed.create(); await ui.nextTick();
  await ui.input('form.book-stack input[maxlength="128"]', '审查同名会员');
  ui.button('保存档案').click(); await until(() => shown('有其他同名的在用会员'));
  const box = document.querySelector('form input[type=checkbox]'); assert.ok(box); assert.equal(box.checked, false);
  assert.equal(ui.button('仍然保存').disabled, true);
  document.querySelector('form.book-stack').dispatchEvent(new ui.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => shown('请先核对并勾选同名会员确认'));
  assert.equal(posts.length, 0);
  box.click(); await ui.nextTick(); ui.button('仍然保存').click();
  await until(() => posts.length === 1);
  assert.equal(posts[0].draft.data.name, '审查同名会员');
  evidence(t, { confirmationChecked: true, uncheckedSubmissions: 0, submittedTasks: posts.length, type: posts[0].draft.type });
});

test('R05: delayed member A history cannot overwrite member B after closing and switching', async t => {
  const a = member('audit-a', '审查甲会员'), b = member('audit-b', '审查乙会员'); rows = [a, b];
  let releaseA, requestedA = false;
  const delayedA = new Promise(resolve => { releaseA = resolve; });
  readOverride = (method, input) => {
    if (method !== 'listLedger') return undefined;
    if (input.memberId === a.id) { requestedA = true; return delayedA; }
    return { items: [{ id: 'beta-entry', type: 'consume', deltaCents: '-100', balanceAfterCents: '400', itemsSummary: '乙会员专属交易', occurredAt: '2026-11-25T00:01:00.000Z' }], nextCursor: null };
  };
  await ui.mount(Members, membersProps()); await until(() => shown(a.name));
  ui.button(a.name).click(); await until(() => requestedA);
  ui.button('收起档案').click(); await ui.nextTick(); ui.button(b.name).click(); await until(() => shown('乙会员专属交易'));
  releaseA({ items: [{ id: 'alpha-entry', type: 'consume', deltaCents: '-200', balanceAfterCents: '300', itemsSummary: '甲会员专属交易', occurredAt: '2026-11-25T00:01:00.000Z' }], nextCursor: null });
  for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); await ui.nextTick(); }
  assert.equal(document.querySelector('[aria-label="复制会员姓名"]').textContent.trim(), b.name);
  assert.equal(shown('甲会员专属交易'), false);
  assert.equal(shown('乙会员专属交易'), true);
  evidence(t, { visibleMember: b.name, visibleTransactionOwner: b.name });
});

test('R06: lifetime totals use a separate complete aggregate and subtract reversed originals', async t => {
  // Twenty-five valid recharge/reversal pairs preserve the opening balance.
  // Their latest fifteen movements contain seven already-reversed recharges.
  const history = Array.from({ length: 25 }, (_, i) => [
    { id: 'recharge-' + i, type: 'recharge', deltaCents: '100', balanceBeforeCents: '500', balanceAfterCents: '600', actualPayCents: '100', giftCents: '0', accountVersion: String(i * 2 + 1), occurredAt: new Date(Date.UTC(2026, 10, 25) + i * 2000).toISOString(), reversed: true, reversalEntryId: 'reversal-' + i },
    { id: 'reversal-' + i, type: 'reversal', deltaCents: '-100', balanceBeforeCents: '600', balanceAfterCents: '500', actualPayCents: '0', giftCents: '0', accountVersion: String(i * 2 + 2), occurredAt: new Date(Date.UTC(2026, 10, 25) + i * 2000 + 1000).toISOString(), originalEntryId: 'recharge-' + i }
  ]).flat().reverse();
  rows[0].accountVersion = '50';
  let requestedLimit, totalsMember;
  readOverride = (method, input) => {
    if (method === 'getMemberTotals') { totalsMember = input; return { grossRechargeCents: '2500', reversedRechargeCents: '2500', netRechargeCents: '0', grossConsumptionCents: '0', reversedConsumptionCents: '0', netConsumptionCents: '0' }; }
    if (method !== 'listLedger') return undefined;
    requestedLimit = input.limit; return { items: history.slice(0, input.limit), nextCursor: 'more-history' };
  };
  await ui.mount(Members, membersProps()); await until(() => shown(member().name));
  ui.button(member().name).click(); await until(() => requestedLimit === 15 && totalsMember === member().id && shown('累计净充值：'));
  await ui.nextTick();
  const label = [...document.querySelectorAll('.member-balance-panel .grid > div')].find(node => node.textContent.includes('累计净充值：'));
  assert.ok(label.textContent.includes('0.00'));
  assert.ok(!label.textContent.includes('7.00'));
  evidence(t, { requestedLimit, lifetimeEntries: history.length, reversedRechargeCount: 25, renderedTotal: label.textContent.trim(), expectedNetCents: '0', lifetimeGrossRechargeCents: '2500' });
});

test('R07: a member API failure is visible and can be retried without displaying an empty ledger', async t => {
  readOverride = method => { if (method === 'listMembers') throw new Error('审查合成数据库连接失败'); return undefined; };
  await ui.mount(Members, membersProps()); await until(() => shown('审查合成数据库连接失败'));
  assert.equal(shown('还没有会员档案'), false);
  readOverride = null; ui.button('重试读取会员').click(); await until(() => shown(member().name));
  assert.equal(shown('审查合成数据库连接失败'), false);
  evidence(t, { failureVisible: true, successfulRetry: true });
});

test('R08: opening and resuming the web cashier preserves a shared manual lock until password login', async t => {
  const { adminApi } = await import('../admin/src/api/session.js');
  const { MerchantSessionClient } = await import('../admin/src/api/merchant-session.js');
  adminApi.lockOptions = { locks: browserLocks() };
  const user = { id: scope.actorId, storeId: scope.storeId, role: 'owner', username: 'audit-owner', displayName: '审查店主' };
  let logins = 0;
  adminApi.requestFetch = async (path, options) => {
    if (path === '/api/v1/auth/login') {
      logins++; assert.equal(JSON.parse(options.body).password, 'Synthetic-Unlock-2026!');
      return Response.json({ accessToken: 'unlocked-access', refreshToken: 'unlocked-refresh', user, entitlements: { features: ['core', 'members', 'cashier'] } });
    }
    if (path === '/api/v2/book') return Response.json({ storeId: scope.storeId, ledgerEpoch: epoch });
    if (path.startsWith('/api/v2/members?')) return Response.json({ items: rows, nextCursor: null });
    throw new Error('Unexpected audit URL: ' + path);
  };
  adminApi.saveSession({ accessToken: 'audit-access', refreshToken: 'audit-refresh', user: { id: scope.actorId, storeId: scope.storeId, role: 'owner', username: 'audit-owner', displayName: '审查店主' }, entitlements: { features: ['core', 'members', 'cashier'] } }, false, { resetIdle: true });
  adminApi.isLocked.value = true; assert.equal(adminApi.isLocked.value, true);
  await ui.mount(Cashier); await until(() => shown('收银工作台已锁屏'));
  window.dispatchEvent(new ui.dom.window.Event('focus'));
  document.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
  window.dispatchEvent(new ui.dom.window.Event('touchstart'));
  await ui.nextTick();
  const other = new MerchantSessionClient({ storage: localStorage, eventTarget: null });
  try {
    assert.equal(adminApi.isLocked.value, true); assert.equal(other.isLocked.value, true);
    assert.equal(shown(member().name), false); assert.equal(logins, 0);
    await ui.input('input[type=password]', 'Synthetic-Unlock-2026!');
    ui.button('解锁').click(); await until(() => shown(member().name));
    other.restoreSession();
    assert.equal(adminApi.isLocked.value, false); assert.equal(other.isLocked.value, false); assert.equal(logins, 1);
  }
  finally { other.dispose(); }
  evidence(t, { lockedOnOpenAndResume: true, passwordLogins: logins, unlockedAfterPasswordVerification: true });
});

test('R09: an authorized Android cashier exposes logout and returns to the login page', async t => {
  const state = reactive({ ready: true, generation: 1, binding: { mode: 'cloud' }, deviceId: scope.deviceId, online: true, user: { id: scope.actorId, storeId: scope.storeId, displayName: '审查店主', role: 'owner' }, storeProfile: { name: '审查合成店' }, serverUrl: 'https://example.test', deviceAccess: { allowed: true, disabled: false, features: ['core', 'members', 'cashier'] } });
  globalThis[nativeKey] = { listeners: new Map(), exits: 0,
    session: { state, init: async () => {}, publishAccess() {}, heartbeat: async () => {}, checkpoint: async () => {}, logout: async () => { state.user = null; state.deviceAccess.allowed = false; } },
    workspace: { ...workspace, mode: 'cloud', state: reactive({ ...workspace.state, replicaReady: true, status: 'ready', pendingCount: 0, pendingRows: [] }), sync: async () => {}, dispose: async () => {} },
    update: { check: async () => null, installedBuild: async () => 200 }
  };
  await ui.mount(NativeCashier); await until(() => shown(member().name));
  ui.button('账号与设置').click(); await ui.nextTick();
  const account = [...document.querySelectorAll('button')].find(node => node.textContent.includes('账号与连接')); assert.ok(account); account.click(); await ui.nextTick();
  assert.ok(shown('账号与设备'));
  const logout = [...document.querySelectorAll('button')].filter(node => /退出|切换账号|重新登录/.test(node.textContent));
  assert.equal(logout.length, 1);
  logout[0].click(); await until(() => shown('登录门店账号'));
  assert.equal(state.user, null);
  evidence(t, { authorized: true, logoutOrSwitchButtons: logout.length, returnedToLogin: true });
});

test('R10: final session and core-feature rejections persistently block the cached native identity', async t => {
  const { relationalTestDatabase } = await import('../server/tests/helpers/relational-database.js');
  const { createService } = await import('../server/tests/helpers/licensed-service.js');
  const { createRelationalNativeSession } = await import('../src/relational-native-session.js');
  const { createDeviceAccess } = await import('../src/device-access.js');
  const { nativeCredentials } = await import('../tests/helpers/native-fixture.mjs');
  const database = await relationalTestDatabase(); t.after(() => database.close());
  const service = createService(database.pool), username = 'audit-revoked-owner', password = 'Synthetic-Audit-2026!';
  await service.createOwner({ username, password });
  let saved = null, failures = [];
  const device = nativeCredentials(randomUUID());
  const native = createRelationalNativeSession({ device, isOnline: () => true,
    access: createDeviceAccess({ vault: { async load() { return saved; }, async save(value) { saved = structuredClone(value); } } }),
    async fetch(url, options) {
      const path = new URL(url).pathname;
      try {
        if (path === '/api/v1/auth/login') return Response.json(await service.login(JSON.parse(options.body), '127.0.0.1'));
        if (path === '/api/v1/auth/refresh') return Response.json(await service.refresh(JSON.parse(options.body).refreshToken));
        const identity = await service.authenticate(options.headers.Authorization?.slice(7));
        if (path === '/api/v2/book') return Response.json(await service.relational.getBook(identity));
        if (path === '/api/v1/device/authorization') return Response.json(await service.deviceAuthorization(identity));
        throw new Error('Unexpected audit native URL: ' + path);
      } catch (error) { failures.push({ status: error.status, code: error.code }); return Response.json({ error: error.message, code: error.code }, { status: error.status ?? 500 }); }
    }
  });
  await native.login('https://audit.example.test', username, password);
  const user = native.state.user;
  await database.pool.query('UPDATE sessions SET revoked=true WHERE user_id=$1', [user.id]);
  await assert.rejects(native.heartbeat(), { status: 401, code: 'AUTH_REQUIRED' });
  assert.ok(failures.some(error => error.status === 401 && error.code === 'AUTH_REQUIRED'));
  assert.equal(native.state.deviceAccess.allowed, false);
  assert.equal(native.state.user, null);
  assert.throws(() => native.authorize({ storeId: user.storeId, mode: 'cloud' }), { code: 'AUTH_CONTEXT_CHANGED' });
  assert.equal((await device.loadSession()).session, null);
  assert.equal(saved.denied, 'AUTH_REQUIRED');
  await database.pool.query('UPDATE sessions SET revoked=false WHERE user_id=$1', [user.id]);
  await native.login('https://audit.example.test', username, password);
  await database.pool.query('UPDATE store_licenses SET features=$1::jsonb WHERE store_id=$2', [JSON.stringify(['members']), user.storeId]);
  await assert.rejects(native.heartbeat(), { status: 403, code: 'FEATURE_DISABLED' });
  assert.ok(failures.some(error => error.status === 403 && error.code === 'FEATURE_DISABLED'));
  assert.equal(native.state.deviceAccess.allowed, false);
  assert.equal(native.state.user, null);
  assert.equal(saved.denied, 'FEATURE_DISABLED');
  assert.throws(() => native.authorize({ storeId: user.storeId, mode: 'cloud' }), { code: 'AUTH_CONTEXT_CHANGED' });
  evidence(t, { serverResponses: failures, deviceAccessAllowed: false, sessionRetained: false, databaseEngine: database.engine });
});

test('R11: negative daily net amounts are plotted below a distinct zero baseline', async t => {
  t.mock.method(Date, 'now', () => Date.UTC(2026, 10, 25, 10));
  const { businessReportInput, businessReportResult } = await import('../src/relational-reports.js');
  const { businessDays } = await import('../src/relational-presentation.js');
  const period = businessReportInput(businessDays('2026-11-01', '2026-11-25'));
  const report = businessReportResult(period, { daily: [{ date: '2026-11-23', actualPayCents: '500', rechargeCount: '1' }, { date: '2026-11-24', reversedActualPayCents: '500', reversedRechargeCount: '1', reversalCount: '1' }], balances: { memberCount: 0, debtCount: 0, zeroCount: 0, lowCount: 0, fundedCount: 0, storedCents: '0', debtCents: '0' }, ranking: [], consumeMemberCount: '0' });
  readOverride = method => method === 'reportBusiness' ? report : method === 'reportBreakdown' ? { items: [], nextCursor: null } : undefined;
  await ui.mount(Reports, { workspace }); await until(() => document.querySelector('svg[aria-label="充值与消费趋势图"]'));
  const groups = [...document.querySelectorAll('svg[aria-label="充值与消费趋势图"] g')];
  const negative = groups.find(group => group.querySelector('title').textContent.startsWith('2026-11-24'));
  const zero = groups.find(group => group.querySelector('title').textContent.startsWith('2026-11-25'));
  assert.ok(negative.querySelector('title').textContent.includes('-5.00'));
  assert.ok(Number(negative.querySelector('circle').getAttribute('cy')) > Number(zero.querySelector('circle').getAttribute('cy')));
  assert.equal(document.querySelector('[data-zero-baseline]').getAttribute('y1'), zero.querySelector('circle').getAttribute('cy'));
  evidence(t, { negativeCents: '-500', zeroCents: '0', negativeY: negative.querySelector('circle').getAttribute('cy'), zeroY: zero.querySelector('circle').getAttribute('cy') });
});

test('R12: selecting today after midnight requests the current UTC+8 business day', async t => {
  let now = Date.UTC(2026, 10, 25, 10), businessCalls = [];
  t.mock.method(Date, 'now', () => now);
  const { businessReportInput, businessReportResult } = await import('../src/relational-reports.js');
  readOverride = (method, input) => {
    if (method === 'reportBreakdown') return { items: [], nextCursor: null };
    if (method !== 'reportBusiness') return undefined;
    businessCalls.push(input);
    return businessReportResult(businessReportInput(input), { daily: [], balances: { memberCount: 0, debtCount: 0, zeroCount: 0, lowCount: 0, fundedCount: 0, storedCents: '0', debtCents: '0' }, ranking: [], consumeMemberCount: '0' });
  };
  await ui.mount(Reports, { workspace }); await until(() => businessCalls.length === 1);
  now += 86400000;
  ui.button('今天').click(); await until(() => businessCalls.length === 2);
  assert.equal(businessCalls[1].from, '2026-11-25T16:00:00.000Z');
  assert.equal(businessCalls[1].to, '2026-11-26T16:00:00.000Z');
  evidence(t, { actualBusinessDate: '2026-11-26', requestedFrom: businessCalls[1].from, requestedTo: businessCalls[1].to, requestedBusinessDate: '2026-11-26' });
});

test('R13: an expired standalone license exposes its reason and a reachable renewal flow', async t => {
  const state = reactive({ ready: true, generation: 1, binding: { mode: 'standalone', storeId: scope.storeId }, deviceId: scope.deviceId, online: false, user: { id: scope.actorId, storeId: scope.storeId, displayName: '审查本地店主', role: 'owner' }, storeProfile: { name: '审查独立离线店' }, deviceAccess: { allowed: false, disabled: false, reason: '离线授权已到期，请联系服务商续期', features: ['core', 'members', 'cashier'] } });
  globalThis[nativeKey] = { listeners: new Map(), exits: 0,
    session: { state, init: async () => {}, publishAccess() {}, heartbeat: async () => {}, checkpoint: async () => {}, activateOffline: async () => {}, logout: async () => { state.user = null; } },
    workspace: { ...workspace, mode: 'standalone', state: reactive({ ...workspace.state, book: null, replicaReady: false, status: 'idle', pendingCount: 0, pendingRows: [] }), connect: async () => {}, sync: async () => {}, dispose: async () => {} },
    update: { check: async () => null, installedBuild: async () => 200 }
  };
  await ui.mount(NativeCashier); await until(() => shown(state.deviceAccess.reason));
  assert.equal(shown('正在打开账本'), false);
  ui.button('退出并续期 / 重新登录').click();
  await until(() => document.querySelector('.offline-activation'));
  assert.ok(document.querySelector('input[type=password]'));
  evidence(t, { authorizationAllowed: false, authorizationDisabled: false, renewalFormVisible: true, loginFormVisible: true });
});


function installNativeFixture(features = ['core', 'members', 'cashier', 'reports', 'settings'], role = 'owner') {
  const state = reactive({
    ready: true, generation: 1, busy: false, binding: { mode: 'cloud', storeId: scope.storeId },
    deviceId: scope.deviceId, online: true, user: { id: scope.actorId, storeId: scope.storeId, displayName: '合成店主', username: 'test-owner', role },
    storeProfile: { name: '手机交互合成店' }, serverUrl: 'https://example.test',
    deviceAccess: { allowed: true, disabled: false, features }
  });
  globalThis[nativeKey] = {
    listeners: new Map(), exits: 0,
    session: { state, init: async () => {}, publishAccess() {}, heartbeat: async () => {}, checkpoint: async () => {}, logout: async () => { state.user = null; } },
    workspace: { ...workspace, mode: 'cloud', state: reactive({ ...workspace.state, replicaReady: true, status: 'ready', pendingCount: 0, pendingRows: [] }), sync: async () => {}, dispose: async () => {} },
    update: { check: async () => null, installedBuild: async () => 200 }
  };
  return state;
}

test('partial debt repayment previews remaining debt without requesting new-debt consent', async () => {
  rows[0].balanceCents = '-500';
  await ui.mount(Sale, { workspace, scope, type: 'recharge', member: rows[0], configuration });
  await ui.input('input[inputmode=decimal]', '1');
  ui.button('核对金额').click(); await ui.nextTick();
  assert.ok(shown('充值后仍有待结欠款'));
  assert.ok(shown('4.00'));
  assert.equal(document.querySelector('input[type=checkbox]'), null);
  assert.equal(ui.button('确认充值').disabled, false);
  ui.button('确认充值').click(); await until(() => posts.length === 1);
  assert.equal(posts[0].draft.actualPayCents, '100');
  assert.equal(posts[0].draft.allowDebt, undefined);
});

test('sale close, backdrop and back controls cannot discard an in-flight financial confirmation', async () => {
  let resolve, closed = 0;
  workspace.submit = () => new Promise(done => { resolve = done; });
  await ui.mount(Sale, { workspace, scope, type: 'recharge', member: rows[0], configuration, onClose: () => { closed++; } });
  await ui.input('input[inputmode=decimal]', '1'); ui.button('核对金额').click(); await ui.nextTick();
  ui.button('确认充值').click(); await until(() => resolve);
  assert.equal(ui.button('关闭会员充值').disabled, true);
  assert.equal(ui.button('返回修改').disabled, true);
  document.querySelector('.feedback-backdrop').click();
  document.querySelector('#app').__vue_app__._instance.exposed.goBack();
  await ui.nextTick();
  assert.ok(document.querySelector('.feedback-dialog')); assert.equal(closed, 0);
  resolve({ commandId: 'inflight-20261125', entryId: 'inflight-20261125', balanceAfterCents: '600', accountVersion: '1' });
  await ui.nextTick();
});

test('password visibility is explicit and resets when a login form clears its value', async () => {
  const password = ref('Synthetic-Password-Only');
  const wrapper = { setup: () => () => h(PasswordField, { modelValue: password.value, 'onUpdate:modelValue': value => { password.value = value; }, required: true }) };
  await ui.mount(wrapper);
  assert.equal(document.querySelector('input').type, 'password');
  ui.button('显示密码').click(); await ui.nextTick();
  assert.equal(document.querySelector('input').type, 'text');
  assert.equal(document.querySelector('input').value, password.value);
  password.value = ''; await ui.nextTick();
  assert.equal(document.querySelector('input').type, 'password');
});

test('the native ledger search field is visible and Query submits the current header text', async () => {
  const calls = [];
  readOverride = (method, input) => method === 'listLedger' ? (calls.push(input), { items: [], nextCursor: null }) : undefined;
  installNativeFixture(['core', 'members', 'cashier']);
  await ui.mount(NativeCashier); await until(() => shown(member().name));
  ui.button('财务流水').click();
  await until(() => document.querySelector('input[aria-label="搜索交易明细"]'));
  await ui.input('input[aria-label="搜索交易明细"]', '合成护理');
  ui.button('查询').click();
  await until(() => calls.some(call => call.search === '合成护理'));
});

test('read-only accounts have no create action and unavailable ledger permission removes the navigation', async () => {
  const state = installNativeFixture(['core', 'members', 'cashier'], 'viewer');
  await ui.mount(NativeCashier); await until(() => shown(member().name));
  assert.equal(document.querySelector('button[aria-label="新增会员"]'), null);
  assert.equal(ui.button('为' + member().name + '扣款').disabled, true);
  state.deviceAccess.features = ['core', 'members']; await ui.nextTick();
  assert.equal(document.querySelector('button[aria-label="财务流水"]'), null);
  assert.ok(document.querySelector('button[aria-label="账号与设置"]'));
});

test('nested modal Escape closes one layer and restores background focus and scroll only at the end', async () => {
  const originalOverflow = document.body.style.overflow;
  installNativeFixture(['core', 'members', 'cashier']);
  await ui.mount(NativeCashier); await until(() => shown(member().name));
  ui.button(member().name).click(); await until(() => document.querySelector('.member-detail-sheet'));
  await until(() => document.querySelector('.app-header').hasAttribute('inert'));
  ui.button('充值').click(); await until(() => document.querySelector('.recharge-sheet'));
  await ui.input('input[inputmode=decimal]', '1'); ui.button('核对金额').click();
  await until(() => document.querySelector('.feedback-dialog'));
  const escape = () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  escape(); await until(() => !document.querySelector('.feedback-dialog'));
  assert.ok(document.querySelector('.recharge-sheet'));
  assert.equal(document.body.style.overflow, 'hidden');
  escape(); await until(() => !document.querySelector('.recharge-sheet'));
  assert.ok(document.querySelector('.member-detail-sheet'));
  escape(); await until(() => !document.querySelector('.member-detail-sheet'));
  await until(() => !document.querySelector('.app-header').hasAttribute('inert'));
  assert.equal(document.body.style.overflow, originalOverflow);
});

test('invalid custom ledger dates produce visible feedback without querying a wrong period', async () => {
  const calls = [];
  readOverride = (method, input) => method === 'listLedger' ? (calls.push(input), { items: [], nextCursor: null }) : undefined;
  await ui.mount(Ledger, { workspace, owner: true });
  await until(() => calls.length === 1);
  ui.button('自选').click(); await ui.nextTick();
  const dates = document.querySelectorAll('input[type=date]');
  dates[0].value = '2026-11-26'; dates[1].value = '2026-11-25';
  for (const date of dates) date.dispatchEvent(new window.Event('input', { bubbles: true }));
  await ui.nextTick(); ui.button('查询').click();
  await until(() => shown('结束日期不能早于起始日期'));
  assert.equal(calls.length, 1);
});

test('ledger presets use UTC+8, follow midnight on foreground and preserve custom dates', async t => {
  let now = Date.UTC(2026, 10, 25, 16, 30);
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  readOverride = (method, input) => method === 'listLedger' ? (calls.push(input), { items: [], nextCursor: null }) : undefined;
  await ui.mount(Ledger, { workspace, owner: true });
  await until(() => calls.length === 1);
  ui.button('近7天').click(); await until(() => calls.length === 2);
  assert.equal(calls.at(-1).from, '2026-11-19T16:00:00.000Z');
  assert.equal(calls.at(-1).to, '2026-11-26T16:00:00.000Z');
  now += 86400000; window.dispatchEvent(new window.Event('focus'));
  await until(() => calls.length === 3);
  assert.equal(calls.at(-1).from, '2026-11-20T16:00:00.000Z');
  assert.equal(calls.at(-1).to, '2026-11-27T16:00:00.000Z');
  ui.button('自选').click(); await ui.nextTick();
  const dates = document.querySelectorAll('input[type=date]');
  dates[0].value = '2026-11-10'; dates[1].value = '2026-11-11';
  for (const date of dates) date.dispatchEvent(new window.Event('input', { bubbles: true }));
  await ui.nextTick(); ui.button('查询').click(); await until(() => calls.length === 4);
  now += 86400000; window.dispatchEvent(new window.Event('focus'));
  await ui.nextTick(); await ui.nextTick();
  assert.equal(calls.length, 4);
  assert.equal(dates[0].value, '2026-11-10'); assert.equal(dates[1].value, '2026-11-11');
  ui.button('查询').click(); await until(() => calls.length === 5);
  assert.equal(calls.at(-1).from, '2026-11-09T16:00:00.000Z');
  assert.equal(calls.at(-1).to, '2026-11-11T16:00:00.000Z');
});

test('the daily overview follows a new business day on foreground and preserves UTC+8 boundaries', async t => {
  let now = Date.UTC(2026, 10, 25, 10);
  t.mock.method(Date, 'now', () => now);
  const { businessReportInput, businessReportResult } = await import('../src/relational-reports.js');
  const calls = [];
  readOverride = (method, input) => {
    if (method !== 'reportBusiness') return undefined;
    calls.push(input);
    return businessReportResult(businessReportInput(input), { daily: [], balances: { memberCount: 0, debtCount: 0, zeroCount: 0, lowCount: 0, fundedCount: 0, storedCents: '0', debtCents: '0' }, ranking: [], consumeMemberCount: '0' });
  };
  installNativeFixture();
  await ui.mount(NativeCashier); await until(() => shown(member().name));
  ui.button('财务流水').click(); await ui.nextTick(); ui.button('今日概览').click();
  await until(() => calls.length === 1);
  now += 86400000; window.dispatchEvent(new window.Event('focus'));
  await until(() => calls.length >= 2);
  assert.equal(calls.at(-1).from, '2026-11-25T16:00:00.000Z');
  assert.equal(calls.at(-1).to, '2026-11-26T16:00:00.000Z');
  assert.ok(shown('今日 2026-11-26'));
});
