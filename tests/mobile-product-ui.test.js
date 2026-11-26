import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { vueUi } from './helpers/vue-ui.mjs';
import { businessReportInput, businessReportResult } from '../src/relational-reports.js';
import { prepareSale } from '../src/relational-sales.js';
import { LICENSE_FEATURES } from '../src/license-policy.js';

const bridge = new URL('./helpers/native-cashier-bridge.mjs', import.meta.url).href;
const fixtureKey = Symbol.for('member.native-ui-fixture');
const scope = { storeId: 'product-store', actorId: 'product-owner', deviceId: 'product-device-2026', ledgerEpoch: '00000000-0000-4000-8000-000000000126' };
const member = { id: 'product-member', name: '产品回归会员', phone: '13800138001', notes: '喜欢自然发型', tags: [], version: '0', accountVersion: '0', balanceCents: '50000', createdAt: '2026-11-25T00:00:00Z', updatedAt: '2026-11-26T00:00:00Z', lastConsumeAt: null };
const config = { version: '0', services: [{ id: 'cut', name: '剪发', priceCents: '3500' }, { id: 'care', name: '护理', priceCents: '8800' }], rechargePlans: [], rechargeSettings: { giftEnabled: true, giftRateBasisPoints: 1000 } };
let ui, Sale, Members, Cashier, Configuration, Reports, Voice, reactive;
before(async t => {
  ui = await vueUi(t, { modules: Object.fromEntries(['@capacitor/app', './relational-native-session.js', './relational-native-workspace.js', './native-update.js'].map(id => [id, bridge])) });
  ({ reactive } = await import('vue'));
  const components = [];
  for (const name of ['components/RelationalSale', 'components/RelationalMembers', 'NativeCashier', 'components/RelationalConfiguration', 'components/RelationalReports', 'components/VoiceSettings']) components.push(await ui.component(new URL('../src/' + name + '.vue', import.meta.url)));
  [Sale, Members, Cashier, Configuration, Reports, Voice] = components;
});
afterEach(() => { ui.unmount(); delete globalThis[fixtureKey]; });
async function settle() { for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); await ui.nextTick(); } }
const has = text => document.querySelector('#app').textContent.includes(text);
async function until(check) { for (let i = 0; i < 100 && !check(); i++) await settle(); assert.ok(check(), document.body.textContent); }
const review = async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle(); };
function fixture({ online = true, mode = 'cloud' } = {}) {
  localStorage.clear();
  let configuration = structuredClone(config);
  const reads = [], writes = [];
  const state = reactive({ ready: true, busy: false, generation: 1, deviceId: scope.deviceId, binding: { mode }, online,
    user: { id: scope.actorId, storeId: scope.storeId, displayName: '回归店主', role: 'owner' }, serverUrl: 'https://example.test', storeProfile: { name: '回归门店', memberNotesLabel: '注意事项' }, deviceAccess: { allowed: true, features: [...LICENSE_FEATURES] } });
  const workspace = { mode, state: reactive({ book: scope, revision: 1, status: 'ready', busy: false, pending: null, pendingError: '', replicaReady: true, pendingCount: 0, pendingRows: [], syncStatus: 'idle' }),
    getScope: () => scope, dispose: async () => {}, sync: async () => {},
    async read(method, input) {
      reads.push({ method, input });
      if (method === 'listMembers') return { items: [member], total: 1, nextCursor: null };
      if (method === 'getMember') return member;
      if (method === 'getMemberTotals') return { netRechargeCents: '0', netConsumptionCents: '0' };
      if (method === 'getConfiguration') return structuredClone(configuration);
      if (method === 'listLedger' || method === 'reportBreakdown') return { items: [], nextCursor: null };
      if (method === 'reportBusiness') return businessReportResult(businessReportInput(input), { daily: [], balances: { memberCount: 1 }, ranking: [], consumeMemberCount: '0' });
      throw new Error('Unexpected read ' + method);
    },
    async submit(kind, draft) {
      writes.push({ kind, draft });
      if (draft.type === 'configuration.update') { configuration = { ...draft.data, version: String(BigInt(configuration.version) + 1n) }; return configuration; }
      return { entryId: 'receipt-product-test', balanceAfterCents: '50000', accountVersion: '1' };
    }
  };
  const f = { workspace, reads, writes, listeners: new Map(), exits: 0,
    session: { state, init: async () => {}, heartbeat: async () => {}, checkpoint: async () => {}, publishAccess() {}, async loadStoreProfile() { return state.storeProfile; }, async saveStoreProfile(profile) { state.storeProfile = profile; return profile; }, getVoiceConfig: async () => ({ version: 0, provider: 'xfyun', enabled: false, serverXfyunConfigured: true, appId: 'test', voiceId: 'x4_xiaoyan' }), getUsers: async () => [] },
    update: { check: async () => null, installedBuild: async () => 1 } };
  globalThis[fixtureKey] = f; return f;
}

test('gift, credit and payment review stay identical; explicit zero overrides the automatic gift', async () => {
  const f = fixture();
  await ui.mount(Sale, { workspace: f.workspace, scope, type: 'recharge', member, configuration: config });
  await ui.input('.recharge-content input[inputmode=decimal]', '100'); await settle();
  assert.equal(document.querySelector('[aria-label="赠送金额"]').value, '10.00');
  assert.match(document.querySelector('.recharge-totals').textContent, /110\.00/);
  ui.button('现金').click(); await review();
  assert.match(document.querySelector('.feedback-dialog').textContent, /收款方式现金/);
  assert.match(document.querySelector('.feedback-dialog').textContent, /10\.00/);
  ui.button('返回修改').click(); await ui.input('[aria-label="赠送金额"]', '0'); await review();
  ui.button('确认充值').click(); await settle();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].draft.giftCents, '0'); assert.equal(f.writes[0].draft.payMethod, '现金');
});

test('combined services, quantities and a long remark produce exact historical line items', async () => {
  const f = fixture(); await ui.mount(Sale, { workspace: f.workspace, scope, type: 'consume', member, configuration: config, memberNotesLabel: '注意事项' });
  const choose = name => [...document.querySelectorAll('.consume-content button')].find(el => el.textContent.includes(name)).click();
  choose('剪发'); await settle(); choose('护理'); await settle();
  assert.match(document.querySelector('.consume-amount-panel').textContent, /123\.00/);
  ui.button('增加剪发').click(); await settle(); assert.match(document.querySelector('.consume-amount-panel').textContent, /158\.00/);
  ui.button('减少剪发').click(); await settle();
  const note = '补充说明'.repeat(40); await ui.input('.consume-content input', note);
  document.querySelector('.consume-content input').dispatchEvent(new window.FocusEvent('focus')); await settle();
  assert.equal(document.querySelector('.consume-keypad'), null);
  await review(); assert.ok(document.querySelector('.feedback-dialog'));
  ui.button('确认扣款').click(); await settle();
  const draft = f.writes[0].draft;
  assert.equal(draft.amountCents, '12300'); assert.equal(draft.items.length, 2); assert.equal(draft.remark, note);
  assert.deepEqual(prepareSale(draft, config).items.map(row => row.lineTotalCents), ['3500', '8800']);
  assert.equal(document.querySelectorAll('[aria-label="清空扣款金额"]').length, 0);
  assert.ok(has('注意事项'));
});

test('normal configuration can save with the actual empty pending error and the next sale reads the new price', async () => {
  const f = fixture(); await ui.mount(Configuration, { workspace: f.workspace, owner: true }); await settle();
  await ui.input('input[id^="service-name-"]', '新剪发');
  const save = document.querySelector('button[type=submit]'); assert.equal(save.disabled, false); save.click(); await settle();
  assert.equal(f.writes.length, 1);
  ui.unmount(); await ui.mount(Configuration, { workspace: f.workspace, owner: true }); await settle();
  assert.equal(document.querySelector('input[id^="service-name-"]').value, '新剪发');
  ui.unmount(); await ui.mount(Sale, { workspace: f.workspace, member, configuration: await f.workspace.read('getConfiguration') });
  const select = [...document.querySelectorAll('.consume-content button')].find(el => el.textContent.includes('新剪发')); assert.ok(select); select.click(); await review();
  assert.match(document.querySelector('.feedback-dialog').textContent, /新剪发/);
});

test('member view reads one page, has accurate visit semantics and hides irrelevant cashier actions', async () => {
  const f = fixture(); await ui.mount(Members, { workspace: f.workspace, writable: true, cashierWritable: false, feature: () => true, showSearch: true, memberNotesLabel: '注意事项' }); await settle();
  assert.equal(f.reads.filter(row => row.method === 'listMembers').length, 1);
  assert.ok(has('共 1 人')); assert.ok(has('暂无有效消费')); assert.equal(document.querySelector('.customer-consume'), null);
  ui.button(member.name).click(); await settle(); assert.equal(document.querySelector('.member-detail-actions'), null); assert.ok(has('注意事项'));
  ui.button('收起档案').click(); await ui.input('[aria-label="搜索会员"]', '1380'); document.querySelector('.member-search').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(f.reads.filter(row => row.method === 'listMembers').at(-1).input.search, '1380');
});

test('member pagination stays bounded while refresh and previous page preserve the browsing range', async () => {
  const f = fixture();
  const original = f.workspace.read;
  f.workspace.read = async (method, input) => method !== 'listMembers' ? original(method, input) : { items: Array.from({ length: 30 }, (_, i) => ({ ...member, id: String((input.cursor ?? 0) * 30 + i), name: '分页会员' + ((input.cursor ?? 0) * 30 + i) })), total: 10000, nextCursor: (input.cursor ?? 0) < 333 ? (input.cursor ?? 0) + 1 : null };
  await ui.mount(Members, { workspace: f.workspace, feature: () => true }); await settle();
  for (let i = 0; i < 21; i++) { ui.button('下一页').click(); await settle(); assert.equal(document.querySelectorAll('.customer-row').length, 30); }
  const first = document.querySelector('.customer-open').textContent; f.workspace.state.revision++; await settle();
  assert.equal(document.querySelector('.customer-open').textContent, first); assert.ok(has('第 22 页'));
  ui.button('上一页').click(); await settle(); assert.ok(has('第 21 页')); assert.equal(document.querySelectorAll('.customer-row').length, 30);
  const read = f.workspace.read;
  f.workspace.read = async (method, input) => { if (method === 'listMembers' && input.balance === 'debt') throw new Error('范围读取失败'); return read(method, input); };
  await ui.input('[aria-label="会员范围"]', 'debt', 'change'); await settle();
  assert.ok(has('范围读取失败')); assert.equal(document.querySelectorAll('.customer-row').length, 0);
  assert.equal(document.querySelector('[aria-label="会员分页"]'), null);
});

test('global ledger clears member scope, and member and ledger searches stay independent', async () => {
  const f = fixture(); await ui.mount(Cashier); await settle();
  await ui.input('[aria-label="搜索会员"]', member.name); ui.button('查询').click(); await settle();
  ui.button(member.name).click(); await settle(); ui.button('查看会员流水').click(); await settle();
  assert.equal(document.querySelector('[aria-label="搜索交易明细"]').value, '');
  ui.button('会员收银').click(); await settle(); assert.equal(document.querySelector('[aria-label="搜索会员"]').value, member.name);
  ui.button('财务流水').click(); await settle();
  const last = f.reads.filter(row => row.method === 'listLedger').at(-1).input;
  assert.equal(last.memberId, ''); assert.equal(last.search, ''); assert.equal(f.writes.length, 0);
});

test('settings drafts survive secondary, main and Android back navigation; offline pages are useful', async () => {
  const f = fixture({ online: false, mode: 'standalone' }); await ui.mount(Cashier); await settle();
  ui.button('账号与设置').click(); await settle(); ui.button('服务与价格').click(); await until(() => document.querySelector('input[id^="service-name-"]'));
  await ui.input('input[id^="service-name-"]', '未保存草稿'); ui.button('返回设置').click(); await settle();
  ui.button('服务与价格').click(); await settle(); assert.equal(document.querySelector('input[id^="service-name-"]').value, '未保存草稿');
  ui.button('会员收银').click(); await settle(); ui.button('账号与设置').click(); await settle(); ui.button('服务与价格').click(); await settle();
  assert.equal(document.querySelector('input[id^="service-name-"]').value, '未保存草稿');
  await f.listeners.get('backButton')(); await settle(); ui.button('门店设置').click(); await settle();
  assert.ok([...document.querySelectorAll('form input')].some(el => !el.disabled && el.value === '回归门店'));
  await ui.input('form input[maxlength="128"]', '门店草稿'); ui.button('返回设置').click(); await settle(); ui.button('门店设置').click(); await settle(); assert.equal(document.querySelector('form input[maxlength="128"]').value, '门店草稿');
  ui.unmount(); const offline = fixture({ online: false }); await ui.mount(Cashier); await settle(); ui.button('账号与设置').click(); await settle(); ui.button('语音播报设置').click(); await settle(); assert.ok(has('联网后可设置语音播报')); assert.equal(offline.writes.length, 0);
});

test('long period daily details and net overview retain their actual reporting granularity', async () => {
  const f = fixture(), input = businessReportInput({ from: '2026-09-01T00:00:00Z', to: '2026-10-31T00:00:00Z', offsetMinutes: 0 });
  const report = businessReportResult(input, { daily: [{ date: input.days[0], consumptionCents: '3500', reversedConsumptionCents: '3500', consumeCount: '1', reversedConsumeCount: '1' }], balances: {}, ranking: [], consumeMemberCount: '1' });
  f.workspace.read = async method => method === 'reportBusiness' ? report : { items: [], nextCursor: null };
  await ui.mount(Reports, { workspace: f.workspace }); await settle();
  assert.equal(document.querySelector('details table tbody').children.length, 60); assert.ok(has('按月')); assert.ok(has('消费 1 笔 · 冲正 1 笔')); assert.equal(has('有效消费'), false); assert.equal(report.summary.netConsumptionCents, '0');
});

test('voice everyday controls precede advanced details and draft status accurately reflects saves', async () => {
  const f = fixture(); const state = reactive({ active: true }); let stopped = 0, previews = 0;
  const { h } = await import('vue');
  const wrapper = { setup: () => () => h(Voice, { active: state.active, api: { ...f.session, saveVoiceConfig: async () => ({ version: 1, provider: 'xfyun', serverXfyunConfigured: true }) }, player: { stop() { stopped++; }, async queueSpeak() { previews++; } }, user: { role: 'owner' } }) };
  await ui.mount(wrapper); await settle();
  assert.ok(has('当前显示已保存配置'));
  const advanced = document.querySelectorAll('.voice-advanced'); assert.equal(advanced.length, 2); assert.ok([...advanced].every(el => !el.open));
  ui.button('播报总开关').click(); await settle(); assert.ok(has('有未保存的修改'));
  ui.button('试听测试').click(); await settle(); assert.equal(previews, 1); assert.ok(has('试听当前编辑内容'));
  state.active = false; await settle(); assert.equal(stopped, 1); assert.ok(has('有未保存的修改'));
  state.active = true; await settle();
  ui.button('保存播报配置').click(); await settle(); assert.ok(has('当前显示已保存配置'));
});
