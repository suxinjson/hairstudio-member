import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { debtNoticeVersion, systemNotices } from '../src/notices.js';
const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost' });
for (const name of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'localStorage']) globalThis[name] = dom.window[name];
const { createApp, ref, computed, nextTick, h } = await import('vue');
const { useNotices } = await import('../src/composables/useNotices.js');
beforeEach(() => { localStorage.clear(); document.body.innerHTML = '<div id="app"></div>'; });
after(() => dom.window.close());
const identity = id => ({ serverUrl: 'https://member.example', user: { id, storeId: 'store-' + id }, online: true });
const debtItems = (version = 'debt-a', amount = 100) => systemNotices({ dashboard: { totalDebt: amount, debtMemberCount: 1 }, debtVersion: version });
function mount(state = ref({}), systemItems = ref(debtItems()), ledgerReady = ref(true)) {
  let center;
  const app = createApp({ setup() { center = useNotices({ state, systemItems, ledgerReady }); return () => h('div'); } });
  app.mount('#app'); return { app, center };
}

test('debt fingerprint tracks member changes even when the total is unchanged', () => {
  assert.notEqual(debtNoticeVersion([{ id: 'a', balance: -100 }]), debtNoticeVersion([{ id: 'b', balance: -100 }]));
  assert.equal(debtNoticeVersion([{ id: 'a', balance: -100 }, { id: 'b', balance: 200 }]), debtNoticeVersion([{ id: 'a', balance: -100 }]));
  const required = systemNotices({ storageError: '损坏', state: { bindingRecovery: true } });
  assert.ok(required.every(item => !item.allowDelete && !item.buttonLabel && item.required));
  const update = systemNotices({ availableUpdate: { versionCode: 2, versionName: '1.0.2', notes: '改进体验' } })[0];
  assert.equal(update.action, 'update'); assert.equal(update.version, '2');
});

test('debt fingerprints track new financial history without reacting to profile edits or another member', () => {
  const members = [{ id: 'a', name: '会员甲', balance: -3800 }, { id: 'b', name: '会员乙', balance: 10000 }];
  const initial = [{ id: 'consume-a', memberId: 'a', type: 'CONSUME' }];
  const baseline = debtNoticeVersion(members, initial);
  const recurrence = [...initial, { id: 'recharge-a', memberId: 'a', type: 'RECHARGE' },
    { id: 'consume-a-again', memberId: 'a', type: 'CONSUME' }];
  assert.notEqual(debtNoticeVersion(members, recurrence), baseline);
  assert.equal(debtNoticeVersion([{ ...members[0], name: '新姓名', notes: '新备注', updated_at: '2026-11-18' }, members[1]], initial), baseline);
  assert.equal(debtNoticeVersion(members, [...initial, { id: 'consume-b', memberId: 'b', type: 'CONSUME' }]), baseline);
  assert.equal(debtNoticeVersion([...members].reverse(), [...recurrence].reverse()), debtNoticeVersion(members, recurrence));
});

test('reminders react to existing data without polling or network requests', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed'); });
  const interval = t.mock.method(globalThis, 'setInterval');
  const state = ref(identity('local')), systemItems = ref(debtItems());
  const { app, center } = mount(state, systemItems);
  try {
    assert.equal(center.pending.value.length, 1);
    assert.equal(center.act(center.items.value[0], 'acknowledge'), true);
    t.mock.timers.tick(120000);
    for (const event of ['online', 'focus']) window.dispatchEvent(new window.Event(event));
    document.dispatchEvent(new window.Event('visibilitychange'));
    await nextTick();
    assert.equal(center.pending.value.length, 0);
    systemItems.value = debtItems('debt-b', 200); await nextTick();
    assert.equal(center.pending.value.length, 1);
    assert.match(center.items.value[0].body, /2.00/);
    assert.equal(center.act(center.items.value[0], 'delete'), true);
    assert.deepEqual(center.items.value, []);
    assert.equal(fetch.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
    assert.equal(center.refresh, undefined);
  } finally { app.unmount(); }
});

test('local acknowledgement and deletion persist independently for each account and server', async () => {
  const state = ref(identity('a')), systemItems = ref(debtItems());
  let mounted = mount(state, systemItems);
  try {
    mounted.center.act(mounted.center.items.value[0], 'acknowledge');
    state.value = identity('b'); await nextTick();
    assert.equal(mounted.center.pending.value.length, 1);
    mounted.center.act(mounted.center.items.value[0], 'delete');
    state.value = identity('a'); await nextTick();
    assert.equal(mounted.center.items.value[0].acknowledged, true);
    state.value = { ...identity('a'), serverUrl: 'https://different.example' }; await nextTick();
    assert.equal(mounted.center.pending.value.length, 1);
    mounted.app.unmount();
    state.value = identity('b'); mounted = mount(state, systemItems);
    assert.deepEqual(mounted.center.items.value, []);
  } finally { mounted.app.unmount(); }
});

test('failed local writes do not hide reminders or mutate the ledger', () => {
  const { app, center } = mount();
  const storage = globalThis.localStorage;
  try {
    globalThis.localStorage = { setItem() { throw new Error('quota'); } };
    assert.throws(() => center.act(center.items.value[0], 'acknowledge'), /quota/);
    assert.equal(center.pending.value.length, 1);
  } finally { globalThis.localStorage = storage; app.unmount(); }
});

test('a resolved debt that later recurs for the same amount is a new reminder', async () => {
  const systemItems = ref(debtItems()), { app, center } = mount(ref({}), systemItems);
  try {
    center.act(center.items.value[0], 'acknowledge'); assert.equal(center.pending.value.length, 0);
    systemItems.value = []; await nextTick();
    systemItems.value = debtItems(); await nextTick();
    assert.equal(center.pending.value.length, 1);
  } finally { app.unmount(); }
});

test('required and changed reminders cannot be dismissed by a stale action', async () => {
  const systemItems = ref(systemNotices({ storageError: '损坏' })), { app, center } = mount(ref({}), systemItems);
  try {
    const forged = { ...center.items.value[0], required: false, allowDelete: true, buttonLabel: '我知道了' };
    assert.equal(center.act(forged, 'delete'), false);
    assert.equal(center.act(forged, 'acknowledge'), false);
    systemItems.value = debtItems('old'); await nextTick();
    const old = center.items.value[0];
    systemItems.value = debtItems('new'); await nextTick();
    assert.equal(center.act(old, 'delete'), false);
    assert.equal(center.pending.value.length, 1);
  } finally { app.unmount(); }
});

for (const action of ['acknowledge', 'delete']) {
  test(`a ${action} receipt is cleared when a debt was paid between app sessions`, async () => {
    const state = ref(identity('a'));
    let mounted = mount(state);
    mounted.center.act(mounted.center.items.value[0], action);
    mounted.app.unmount();
    const systemItems = ref([]), ledgerReady = ref(false);
    mounted = mount(state, systemItems, ledgerReady);
    try {
      ledgerReady.value = true; await nextTick();
      systemItems.value = debtItems(); await nextTick();
      assert.equal(mounted.center.pending.value.length, 1);
      assert.equal(mounted.center.items.value[0].acknowledged, false);
    } finally { mounted.app.unmount(); }
  });

  test(`switching accounts during an empty projection preserves the destination ${action} receipt`, async () => {
    const state = ref(identity('b')), systemItems = ref(debtItems('debt-b')), ledgerReady = ref(true);
    const { app, center } = mount(state, systemItems, ledgerReady);
    try {
      center.act(center.items.value[0], action);
      const key = 'member_notice_receipts_v1:' + center.scope.value;
      const saved = localStorage.getItem(key);
      state.value = identity('a'); systemItems.value = debtItems('debt-a'); await nextTick();
      ledgerReady.value = false; systemItems.value = []; state.value = identity('b'); await nextTick();
      assert.equal(localStorage.getItem(key), saved);
      systemItems.value = debtItems('debt-b'); await nextTick();
      ledgerReady.value = true; await nextTick();
      assert.equal(center.pending.value.length, 0);
      assert.equal(localStorage.getItem(key), saved);
      assert.equal(center.items.value.length, action === 'delete' ? 0 : 1);
    } finally { app.unmount(); }
  });
}

test('startup does not erase an acknowledged debt before the ledger is loaded', async () => {
  const state = ref(identity('a'));
  let mounted = mount(state);
  mounted.center.act(mounted.center.items.value[0], 'acknowledge');
  mounted.app.unmount();
  const systemItems = ref([]), ledgerReady = ref(false);
  mounted = mount(state, systemItems, ledgerReady);
  try {
    await nextTick();
    systemItems.value = debtItems(); ledgerReady.value = true; await nextTick();
    assert.equal(mounted.center.pending.value.length, 0);
    assert.equal(mounted.center.items.value[0].acknowledged, true);
  } finally { mounted.app.unmount(); }
});

for (const action of ['acknowledge', 'delete']) {
  test(`retrying an empty outbox preserves its ${action} receipt until synchronization succeeds`, async () => {
    const state = ref({ ...identity('a'), binding: { storeId: 'store-a' }, syncStatus: 'error' });
    const systemItems = computed(() => systemNotices({ state: state.value }));
    const { app, center } = mount(state, systemItems);
    try {
      center.act(center.items.value[0], action);
      state.value.syncStatus = 'checking'; await nextTick();
      assert.equal(center.items.value.length, 0);
      state.value.syncStatus = 'error'; await nextTick();
      assert.equal(center.pending.value.length, 0);
      state.value.syncStatus = 'confirmed'; await nextTick();
      state.value.syncStatus = 'error'; await nextTick();
      assert.equal(center.pending.value.length, 1);
    } finally { app.unmount(); }
  });

  test(`sync retries and transport changes preserve a pending outbox's ${action} receipt across restarts`, async () => {
    const state = ref({ ...identity('a'), binding: { storeId: 'store-a' },
      outbox: [{ id: 'pending-a' }], syncStatus: 'error' });
    const systemItems = computed(() => systemNotices({ state: state.value }));
    let mounted = mount(state, systemItems);
    try {
      mounted.center.act(mounted.center.items.value[0], action);
      for (const [online, syncStatus] of [[true, 'checking'], [true, 'error'], [true, 'pending'],
        [false, 'error'], [true, 'checking'], [false, 'error']]) {
        Object.assign(state.value, { online, syncStatus }); await nextTick();
        assert.equal(mounted.center.pending.value.length, 0, `${online}:${syncStatus}`);
        assert.equal(mounted.center.headerItems.value.length, 0);
        assert.equal(mounted.center.items.value.length, action === 'delete' ? 0 : 1);
      }
      mounted.app.unmount(); mounted = mount(state, systemItems);
      assert.equal(mounted.center.pending.value.length, 0);
      state.value.outbox.push({ id: 'pending-b' }); await nextTick();
      assert.equal(mounted.center.pending.value.length, 1);
    } finally { mounted.app.unmount(); }
  });

  test(`a confirmed synchronization clears the ${action} receipt before another same-size outbox`, async () => {
    const state = ref({ ...identity('a'), binding: { storeId: 'store-a' },
      outbox: [{ id: 'pending-a' }], syncStatus: 'error' });
    const systemItems = computed(() => systemNotices({ state: state.value }));
    const { app, center } = mount(state, systemItems);
    try {
      center.act(center.items.value[0], action);
      Object.assign(state.value, { outbox: [], syncStatus: 'checking' }); await nextTick();
      assert.equal(center.items.value.length, 0);
      state.value.syncStatus = 'confirmed'; await nextTick();
      Object.assign(state.value, { outbox: [{ id: 'pending-b' }], syncStatus: 'pending' }); await nextTick();
      assert.equal(center.pending.value.length, 1);
    } finally { app.unmount(); }
  });

  test(`legacy sync ${action} receipts survive the new version format and still report login requirements`, async () => {
    const state = ref({ ...identity('a'), binding: { storeId: 'store-a' },
      outbox: [{ id: 'pending-a' }], syncStatus: 'checking', syncLoginRequired: false });
    const key = 'member_notice_receipts_v1:' + JSON.stringify(['https://member.example', 'store-a', 'a']);
    localStorage.setItem(key, JSON.stringify({ 'system:sync': {
      version: '1:false:false:error', acknowledged: true, deleted: action === 'delete'
    } }));
    const systemItems = computed(() => systemNotices({ state: state.value }));
    const { app, center } = mount(state, systemItems);
    try {
      assert.equal(center.pending.value.length, 0);
      assert.equal(center.items.value.length, action === 'delete' ? 0 : 1);
      state.value.syncLoginRequired = true; await nextTick();
      assert.equal(center.pending.value.length, 1);
      assert.equal(center.items.value[0].title, '请重新登录同步');
    } finally { app.unmount(); }
  });
}
