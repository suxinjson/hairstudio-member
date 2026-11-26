import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { vueUi } from './helpers/vue-ui.mjs';

let ui, adminApi, VoiceSettings, Devices, App;
const owner = { id: 'owner-A', storeId: 'store-A', username: 'owner-A', displayName: '门店 A', role: 'owner' };
before(async t => {
  ui = await vueUi(t);
  ({ adminApi } = await import('../admin/src/api/session.js'));
  VoiceSettings = await ui.component(new URL('../admin/src/views/VoiceSettingsView.vue', import.meta.url));
  Devices = await ui.component(new URL('../admin/src/views/DevicesView.vue', import.meta.url));
  App = await ui.component(new URL('../admin/src/App.vue', import.meta.url));
});
beforeEach(() => {
  adminApi.clearSession();
  adminApi.saveSession({ accessToken: 'access', refreshToken: 'refresh', user: owner }, false);
});
afterEach(() => ui.unmount());
const button = label => {
  const buttons = [...document.querySelectorAll('button')];
  const found = buttons.find(element => element.textContent.trim() === label)
    ?? buttons.find(element => element.textContent.includes(label));
  assert.ok(found, 'Missing button: ' + label); return found;
};
const input = (...args) => ui.input(...args);
const nextTick = () => ui.nextTick();
async function flush() { await new Promise(resolve => setImmediate(resolve)); await nextTick(); }
async function mount(component) { await ui.mount(component); await flush(); }

test('owner stages a discovered speaker, removes the literal wildcard, and binds only when saving', async t => {
  t.mock.method(adminApi, 'getVoiceConfig', async () => ({ provider: 'fish_audio', version: 8, hasApiKey: true,
    aligenie: { enabled: true, actorId: owner.id, allowedDevices: ['*','existing-device'], hasToken: true } }));
  t.mock.method(adminApi, 'getUsers', async () => [{ ...owner, active: true }]);
  t.mock.method(adminApi, 'getAliGenieDevices', async () => [{deviceOpenId:'new-speaker-id',lastSeenAt:'2026-11-07T08:00:00Z'}]);
  const save = t.mock.method(adminApi, 'saveVoiceConfig', async (config, expectedVersion) => ({...config,version:expectedVersion+1,hasApiKey:true,aligenie:{...config.aligenie,hasToken:true}}));
  await mount(VoiceSettings);
  button('刷新待绑定音箱').click(); await flush();
  assert.ok(document.body.textContent.includes('new-speaker-id'));
  button('加入允许设备').click(); await flush();
  assert.equal(document.querySelector('[aria-label="天猫精灵设备白名单"]').value, 'existing-device\nnew-speaker-id');
  assert.equal(save.mock.callCount(), 0);
  assert.equal(button('已加入，保存后生效').disabled, true);
  button('保存播报配置').click(); await flush();
  assert.deepEqual(save.mock.calls[0].arguments[0].aligenie.allowedDevices,['existing-device','new-speaker-id']);
  assert.equal(save.mock.calls[0].arguments[0].aligenie.token,'');
  assert.equal(save.mock.calls[0].arguments[1], 8);
});

test('voice conflicts preserve draft inputs and use the new version only after explicitly reloading', async t => {
  let current = { enabled: true, provider: 'fish_audio', version: 2, templates: { consume: '原模板' } };
  t.mock.method(adminApi, 'getVoiceConfig', async () => current);
  t.mock.method(adminApi, 'getUsers', async () => []);
  const save = t.mock.method(adminApi, 'saveVoiceConfig', async (config, expectedVersion) => {
    if (expectedVersion !== current.version) throw Object.assign(new Error('配置冲突'), { status: 409, code: 'VOICE_CONFIG_CHANGED' });
    current = { ...config, version: expectedVersion + 1 };
    return current;
  });
  await mount(VoiceSettings);
  await input('[aria-label="消费播报语句"]', '我的草稿');
  current = { ...current, enabled: false, version: 3, templates: { consume: '其他页面模板' } };
  button('保存播报配置').click(); await flush();
  assert.match(document.body.textContent, /已被其他页面修改/);
  assert.equal(document.querySelector('[aria-label="消费播报语句"]').value, '我的草稿');
  button('保存播报配置').click(); await flush();
  assert.deepEqual(save.mock.calls.map(call => call.arguments[1]), [2, 2]);
  button('重新加载配置').click(); await flush();
  assert.equal(document.querySelector('[aria-label="消费播报语句"]').value, '其他页面模板');
  assert.equal(document.querySelector('[aria-label="播报总开关"]').getAttribute('aria-checked'), 'false');
  button('保存播报配置').click(); await flush();
  button('保存播报配置').click(); await flush();
  assert.deepEqual(save.mock.calls.map(call => call.arguments[1]), [2, 2, 3, 4]);
  assert.equal(current.enabled, false);
});

test('owner voice settings use blank secret inputs and clear newly submitted credentials after saving', async t => {
  t.mock.method(adminApi, 'getVoiceConfig', async () => ({ enabled: false, provider: 'fish_audio', version: 0, apiKey: '', hasApiKey: true,
    aligenie: { enabled: true, actorId: owner.id, allowedDevices: ['test-device'], hasToken: true } }));
  t.mock.method(adminApi, 'getUsers', async () => [{ ...owner, active: true }]);
  const save = t.mock.method(adminApi, 'saveVoiceConfig', async () => ({ version: 1, hasApiKey: true, aligenie: { hasToken: true } }));
  await mount(VoiceSettings);
  const secrets = [document.querySelector('[aria-label="语音服务密钥"]'), document.querySelector('[aria-label="天猫精灵签名密钥"]')];
  assert.equal(secrets.length, 2); assert.equal(secrets[0].value, ''); assert.equal(secrets[1].value, '');
  secrets[0].value = 'new-provider-key'; secrets[0].dispatchEvent(new window.Event('input', { bubbles: true }));
  secrets[1].value = 'new-signing-secret-' + 'x'.repeat(32); secrets[1].dispatchEvent(new window.Event('input', { bubbles: true }));
  button('保存播报配置').click(); await flush();
  assert.equal(save.mock.calls[0].arguments[0].apiKey, 'new-provider-key');
  assert.deepEqual(save.mock.calls[0].arguments[0].aligenie.allowedDevices, ['test-device']);
  assert.equal(secrets[0].value, ''); assert.equal(secrets[1].value, '');
});

test('switching providers resets API parameters and requires the matching provider key before preview', async t => {
  t.mock.method(adminApi, 'getVoiceConfig', async () => ({ enabled: false, provider: 'fish_audio', version: 0, hasApiKey: true,
    apiUrl: 'https://api.fish.audio/v1/tts', model: 'fish-custom-model', voiceId: 'fish-custom-voice' }));
  t.mock.method(adminApi, 'getUsers', async () => []);
  const { voicePlayer } = await import('../admin/src/utils/voice-player.js');
  const preview = t.mock.method(voicePlayer, 'queueSpeak', async () => {});
  await mount(VoiceSettings);
  const chooseProvider = name => [...document.querySelectorAll('div')].find(element => element.textContent.trim() === name).click();
  await input('[aria-label="语音服务密钥"]', 'fish-draft-secret');
  chooseProvider('HeyGen'); await flush();
  const key = document.querySelector('[aria-label="语音服务密钥"]');
  assert.equal(key.value, ''); assert.match(key.placeholder, /当前服务商/);
  const values = [...document.querySelectorAll('input')].map(element => element.value);
  assert.ok(values.includes('https://api.heygen.com/v3/models/audio/tts'));
  assert.ok(values.includes('heygen-voice-1-turbo-free'));
  assert.ok(values.includes('83548de556df48ba8c09c42a57c51d85'));
  button('试听测试').click(); await flush();
  assert.equal(preview.mock.callCount(), 0);
  assert.match(document.body.textContent, /当前服务商的 API Key/);
  await input('[aria-label="语音服务密钥"]', 'heygen-draft-secret');
  button('试听测试').click(); await flush();
  assert.equal(preview.mock.callCount(), 1);
  assert.equal(preview.mock.calls[0].arguments[1].testOptions.apiKey, 'heygen-draft-secret');
  assert.equal(preview.mock.calls[0].arguments[1].testOptions.apiUrl, 'https://api.heygen.com/v3/models/audio/tts');
  chooseProvider('Fish Audio'); await flush();
  assert.match(key.placeholder, /云端已配置/);
});

test('Xfyun settings preview uses the server password without exposing it to the browser and allows voice selection', async t => {
  t.mock.method(adminApi, 'getVoiceConfig', async () => ({ enabled: false, provider: 'fish_audio', version: 0, hasApiKey: false,
    serverXfyunConfigured: true, appId: 'serverappid' }));
  t.mock.method(adminApi, 'getUsers', async () => []);
  const { voicePlayer } = await import('../admin/src/utils/voice-player.js');
  const preview = t.mock.method(voicePlayer, 'queueSpeak', async () => {});
  const save = t.mock.method(adminApi, 'saveVoiceConfig', async (config, expectedVersion) => ({ ...config, version: expectedVersion + 1, hasApiKey: true, serverXfyunConfigured: true }));
  await mount(VoiceSettings); button('讯飞在线语音').click(); await flush();
  assert.equal(document.querySelector('input[type="password"]').value, '');
  assert.equal(document.querySelector('input[placeholder="控制台的 APPID"]').value, 'serverappid');
  assert.equal(document.body.textContent.includes('模型标识'), false);
  const select = [...document.querySelectorAll('select')].find(element => element.value === 'x4_xiaoyan');
  assert.ok(select); select.value = 'aisjinger'; select.dispatchEvent(new window.Event('change', { bubbles: true })); await nextTick();
  button('试听测试').click(); await flush();
  const testOptions = preview.mock.calls[0].arguments[1].testOptions;
  assert.equal(testOptions.provider, 'xfyun'); assert.equal(testOptions.appId, 'serverappid');
  assert.equal(testOptions.apiKey, ''); assert.equal(testOptions.voiceId, 'aisjinger');
  assert.equal(testOptions.apiUrl, 'wss://tts-api.xfyun.cn/v2/tts');
  button('保存播报配置').click(); await flush();
  assert.equal(save.mock.calls[0].arguments[0].appId, 'serverappid');
  assert.equal(save.mock.calls[0].arguments[0].apiKey, '');
});

test('device management saves offline prohibition, expiry and disabling while keeping failed edits for retry', async t => {
  const device = { deviceId: 'phone-device-00001', kind: 'native', displayName: '店内手机', label: '', active: true,
    offlineHours: 168, authorizedUntil: null, lastSeenAt: '2026-11-11T00:00:00Z' };
  t.mock.method(adminApi, 'getDevices', async () => [{ ...device }]);
  const payloads = []; let rejectSave = true;
  t.mock.method(adminApi, 'updateDevice', async (id, payload) => { payloads.push({ id, payload }); if (rejectSave) throw new Error('保存失败，请重试'); });
  t.mock.method(window, 'confirm', () => true);
  await mount(Devices);
  const mode = document.querySelector('select'); mode.value = 'deny'; mode.dispatchEvent(new window.Event('change', { bubbles: true }));
  await input('input[type="datetime-local"]', '2026-12-01T12:00');
  button('保存授权').click(); await flush();
  assert.ok(document.body.textContent.includes('保存失败'));
  assert.equal(mode.value, 'deny'); assert.equal(document.body.textContent.includes('设备授权已保存'), false);
  rejectSave = false; button('禁用设备').click(); await flush();
  assert.equal(payloads.at(-1).id, device.deviceId);
  assert.equal(payloads.at(-1).payload.active, false); assert.equal(payloads.at(-1).payload.offlineHours, 0);
  assert.equal(payloads.at(-1).payload.authorizedUntil, new Date('2026-12-01T12:00').toISOString());
  assert.ok(document.body.textContent.includes('设备授权已保存'));
});

test('PC lock, account changes and unmount stop speech immediately', async t => {
  const { voicePlayer } = await import('../admin/src/utils/voice-player.js');
  const stop = t.mock.method(voicePlayer, 'stop', () => {});
  t.mock.method(adminApi, 'request', async () => { throw new Error('账本暂不可用'); });
  await mount(App);
  const count = stop.mock.callCount();
  adminApi.isLocked.value = true;
  assert.equal(stop.mock.callCount(), count + 1);
  adminApi.clearSession();
  assert.ok(stop.mock.callCount() > count + 1);
  const beforeUnmount = stop.mock.callCount();
  ui.unmount();
  assert.equal(stop.mock.callCount(), beforeUnmount + 1);
});
