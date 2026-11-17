import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="app"></div>', { url: 'https://localhost' });
for (const key of ['window', 'document', 'Element', 'HTMLElement', 'SVGElement', 'Node']) globalThis[key] = dom.window[key];
const { createApp, ref, nextTick } = await import('vue');
const { useAppUpdate } = await import('../src/composables/useAppUpdate.js');
const manifest = { versionCode: 70, versionName: '1.0.70', notes: '修复记账与同步问题' };
let app, state, ready, canPrompt, check, askConfirm, onUpdate, controller;
const flush = async () => { for (let i = 0; i < 20; i++) await nextTick(); };

beforeEach(t => {
  document.body.innerHTML = '<div id="app"></div>';
  state = ref({ user: { id: 'owner', storeId: 'store' }, serverUrl: 'https://member.example', online: true });
  ready = ref(false); canPrompt = ref(true);
  check = t.mock.fn(async () => manifest);
  askConfirm = t.mock.fn(async () => false);
  onUpdate = t.mock.fn();
});
afterEach(() => { app?.unmount(); app = null; });
after(() => dom.window.close());

async function mount(isNativeApp = true) {
  app = createApp({
    setup() { controller = useAppUpdate({ state, ready, isNativeApp, canPrompt, check, askConfirm, onUpdate }); return () => null; }
  });
  app.mount('#app'); await flush();
}

test('startup waits for restored login then prompts with version notes and opens the existing update page on confirmation', async () => {
  askConfirm.mock.mockImplementation(async () => true);
  await mount();
  assert.equal(check.mock.callCount(), 0);
  ready.value = true; await flush();
  assert.equal(check.mock.callCount(), 1);
  assert.equal(askConfirm.mock.callCount(), 1);
  assert.match(askConfirm.mock.calls[0].arguments[0].title, /1\.0\.70/);
  assert.match(askConfirm.mock.calls[0].arguments[0].message, /修复记账/);
  assert.deepEqual(onUpdate.mock.calls[0].arguments, [manifest]);
  assert.deepEqual(controller.availableUpdate.value, manifest);
});

test('offline startup checks after connection and a later login without blocking local use', async () => {
  ready.value = true; state.value.online = false; state.value.user = null;
  await mount(); assert.equal(check.mock.callCount(), 0);
  state.value.online = true; await flush(); assert.equal(check.mock.callCount(), 0);
  state.value.user = { id: 'owner', storeId: 'store' }; await flush();
  assert.equal(check.mock.callCount(), 1);
  assert.equal(askConfirm.mock.callCount(), 1);
});

test('every reopening checks and prompts for the same dismissed version without a cooldown', async () => {
  ready.value = true; await mount();
  await Promise.all([controller.checkOnOpen(), controller.checkOnOpen()]);
  assert.equal(check.mock.callCount(), 1);
  for (let opening = 2; opening <= 4; opening++) {
    controller.onBackground(); controller.onBackground();
    await Promise.all([controller.checkOnOpen(), controller.checkOnOpen()]); await flush();
    assert.equal(check.mock.callCount(), opening);
    assert.equal(askConfirm.mock.callCount(), opening);
    assert.match(askConfirm.mock.calls.at(-1).arguments[0].title, /1\.0\.70/);
    await controller.checkOnOpen(); await flush();
    assert.equal(askConfirm.mock.callCount(), opening);
  }
  assert.equal(onUpdate.mock.callCount(), 0);
});

test('a response received in the background is ignored and the next opening fetches again', async () => {
  let finish;
  check.mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  ready.value = true; await mount();
  controller.onBackground();
  window.dispatchEvent(new dom.window.Event('online'));
  finish(manifest); await flush();
  assert.equal(check.mock.callCount(), 1);
  assert.equal(askConfirm.mock.callCount(), 0);
  await controller.checkOnOpen(); await flush();
  assert.equal(check.mock.callCount(), 2);
  assert.equal(askConfirm.mock.callCount(), 1);
});

test('reopening during an in-flight check fetches a fresh result without duplicate dialogs', async () => {
  let finish;
  check.mock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  ready.value = true; await mount();
  controller.onBackground();
  await controller.checkOnOpen();
  finish(manifest); await flush();
  assert.equal(check.mock.callCount(), 2);
  assert.equal(askConfirm.mock.callCount(), 1);
});

test('automatic update prompts wait until an accounting dialog is closed', async () => {
  ready.value = true; canPrompt.value = false; await mount();
  assert.equal(check.mock.callCount(), 1);
  assert.equal(askConfirm.mock.callCount(), 0);
  canPrompt.value = true; await flush();
  assert.equal(askConfirm.mock.callCount(), 1);
});

test('reopening with an update dialog still visible checks again without stacking another dialog', async () => {
  let dismiss;
  askConfirm.mock.mockImplementationOnce(() => new Promise(resolve => { dismiss = resolve; }));
  ready.value = true; await mount();
  controller.onBackground(); await controller.checkOnOpen(); await flush();
  assert.equal(check.mock.callCount(), 2);
  assert.equal(askConfirm.mock.callCount(), 1);
  dismiss(false); await flush();
  controller.onBackground(); await controller.checkOnOpen(); await flush();
  assert.equal(check.mock.callCount(), 3);
  assert.equal(askConfirm.mock.callCount(), 2);
});

test('routine ledger and busy-state emissions do not restart update checks or discard the discovered version', async () => {
  ready.value = true; await mount();
  for (const busy of [true, false, true, false]) {
    state.value = { ...state.value, busy, revision: (state.value.revision || 0) + 1 };
    await flush();
  }
  assert.equal(check.mock.callCount(), 1);
  assert.deepEqual(controller.availableUpdate.value, manifest);
  assert.equal(askConfirm.mock.callCount(), 1);
});

test('network failures and already-current versions stay silent and retry on the next foreground', async () => {
  ready.value = true;
  check.mock.mockImplementationOnce(async () => { throw new Error('offline'); });
  check.mock.mockImplementationOnce(async () => null, 1);
  await mount(); assert.equal(askConfirm.mock.callCount(), 0);
  controller.onBackground(); await controller.checkOnOpen(); await flush();
  assert.equal(askConfirm.mock.callCount(), 0);
  controller.onBackground(); await controller.checkOnOpen(); await flush();
  assert.equal(askConfirm.mock.callCount(), 1);
});

for (const change of ['logout', 'unmount']) {
  test(`a late update response after ${change} cannot display a prompt`, async () => {
    let finish;
    check.mock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    ready.value = true; await mount();
    if (change === 'logout') state.value.user = null;
    else { app.unmount(); app = null; }
    await flush(); finish(manifest); await flush();
    assert.equal(askConfirm.mock.callCount(), 0);
    assert.equal(onUpdate.mock.callCount(), 0);
  });
}

test('web cashier never prompts to install an Android APK', async () => {
  ready.value = true; await mount(false);
  await controller.checkOnOpen();
  assert.equal(check.mock.callCount(), 0);
  assert.equal(askConfirm.mock.callCount(), 0);
});
