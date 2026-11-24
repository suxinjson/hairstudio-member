import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { vueUi } from './helpers/vue-ui.mjs';

const bridge = new URL('./helpers/native-cashier-bridge.mjs', import.meta.url).href;
const key = Symbol.for('member.native-ui-fixture');
const member = { id: 'synthetic-native', name: '合成本机会员', phone: '0012345', notes: '', tags: [], balanceCents: '250', version: '0', accountVersion: '0' };
const manifest = { versionName: '2.0.1', versionCode: 210, sha256: 'a'.repeat(64), notes: '隔离更新说明' };
let ui, Cashier, reactive, fixture;

before(async t => {
  ui = await vueUi(t, { modules: { '@capacitor/app': bridge, './relational-native-session.js': bridge,
    './relational-native-workspace.js': bridge, './native-update.js': bridge } });
  ({ reactive } = await import('vue'));
  Cashier = await ui.component(new URL('../src/NativeCashier.vue', import.meta.url));
});
beforeEach(t => {
  localStorage.clear();
  const state = reactive({ ready: false, generation: 1, binding: { mode: 'cloud' }, deviceId: 'device-cashier-ui', online: true,
    user: { id: 'test-owner', storeId: 'test-shop', displayName: '测试店主', role: 'owner' }, storeProfile: { name: '隔离测试店' },
    serverUrl: 'https://example.test', deviceAccess: { allowed: true, features: ['core', 'members', 'cashier'] } });
  const scope = { storeId: state.user.storeId, actorId: state.user.id, deviceId: state.deviceId, ledgerEpoch: '00000000-0000-4000-8000-000000000021' };
  fixture = globalThis[key] = { listeners: new Map(), exits: 0, manifest: null,
    session: { state, init: async () => { state.ready = true; }, publishAccess() {}, heartbeat: async () => {}, checkpoint: async () => {} },
    workspace: { mode: 'cloud', state: reactive({ book: { storeId: scope.storeId, ledgerEpoch: scope.ledgerEpoch }, replicaReady: true, status: 'ready', revision: 1, pendingCount: 0, pendingRows: [] }),
      getScope: () => scope, sync: async () => {}, dispose: async () => {},
      async read(method) {
        if (method === 'listMembers') return { items: [member], nextCursor: null };
        if (method === 'listLedger') return { items: [], nextCursor: null };
        if (method === 'getMember') return member;
        if (method === 'getConfiguration') return { version: '0', services: [], rechargePlans: [], rechargeSettings: { giftEnabled: false, giftRateBasisPoints: 0 } };
        assert.fail('Unexpected read ' + method);
      }, submit: t.mock.fn(async () => { assert.fail('navigation must never post a command'); }) },
    update: { check: t.mock.fn(async () => fixture.manifest), download: t.mock.fn(async value => ({ fileName: value.sha256 + '.apk', verified: true })),
      installedBuild: async () => 200, install: t.mock.fn(async () => ({ status: 'installer-opened' })) }
  };
});
afterEach(() => { ui.unmount(); delete globalThis[key]; });

const shown = value => document.querySelector('#app').textContent.includes(value);
async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setImmediate(resolve)); await ui.nextTick();
  }
  assert.ok(check(), document.body.textContent);
}
async function back() { await fixture.listeners.get('backButton')(); await ui.nextTick(); }
async function reviewRecharge() {
  await ui.mount(Cashier); await until(() => shown(member.name));
  ui.button(member.name).click(); await until(() => shown('收起档案'));
  ui.button('充值').click(); await until(() => shown('实收（元）'));
  await ui.input('input[inputmode="decimal"]', '1.24');
  ui.button('核对金额').click(); await ui.nextTick();
  assert.ok(shown('确认充值'));
}

test('Android back steps through a reviewed sale and its member before counting exit presses', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  await reviewRecharge();
  await back(); assert.equal(shown('确认充值'), false); assert.ok(shown('核对金额'));
  await back(); assert.equal(shown('核对金额'), false); assert.ok(shown('收起档案'));
  await back(); assert.equal(shown('收起档案'), false); assert.equal(fixture.exits, 0);
  ui.button('财务流水').click(); await ui.nextTick();
  await back(); assert.ok(shown('搜索会员'));
  await back(); assert.ok(shown('再按两次返回键'));
  now += 2001; await back(); assert.ok(shown('再按两次返回键'));
  await back(); assert.ok(shown('再按一次返回键'));
  await back(); assert.equal(fixture.exits, 1);
  assert.equal(fixture.workspace.submit.mock.callCount(), 0);
  ui.unmount(); await ui.nextTick(); assert.equal(fixture.listeners.size, 0);
});

test('a native foreground update waits for the sale to close and opens its installer from the existing notice', async () => {
  await reviewRecharge();
  assert.equal(fixture.update.check.mock.callCount(), 1);
  fixture.manifest = manifest;
  const stateChange = fixture.listeners.get('appStateChange');
  stateChange({ isActive: false }); stateChange({ isActive: true });
  await until(() => fixture.update.check.mock.callCount() === 2);
  const dialog = () => document.querySelector('[role="alertdialog"]');
  assert.equal(dialog(), null);
  await back(); assert.equal(dialog(), null);
  await back(); await until(() => dialog()?.textContent.includes('发现新版本 2.0.1'));
  ui.button('前往更新').click();
  await until(() => shown('已打开系统安装界面'));
  assert.equal(fixture.update.check.mock.callCount(), 2);
  assert.equal(fixture.update.download.mock.callCount(), 1);
  assert.equal(fixture.update.install.mock.callCount(), 1);
  assert.equal(fixture.workspace.submit.mock.callCount(), 0);
});
