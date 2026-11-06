import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCloudClient } from '../src/cloud-client.js';
import { localDb } from '../src/storage.js';
import { saveCloudState, getCloudState } from '../src/cloud-storage.js';
import { appVoicePlayer } from '../src/app-voice.js';
import { cloudClient } from '../src/cloud-device.js';

beforeEach(() => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
  localDb.init();
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const config = { enabled: true, volume: 1, templates: { consume: '{name}消费{amount}元' } };

async function connected(handler) {
  const user = { id: 'user-1', storeId: 'store-1', role: 'clerk' };
  saveCloudState({ ...getCloudState(), deviceId: 'device-00000000001', serverUrl: 'https://member.example.com', user, binding: { storeId: user.storeId }, status: 'synced' });
  const requests = []; let refreshes = 0;
  const client = createCloudClient({ allowOffline: true, isOnline: () => true,
    vault: { load: async () => ({ serverUrl: 'https://member.example.com', userId: user.id, storeId: user.storeId, refreshToken: 'refresh-0' }), save: async () => {}, clear: async () => {} },
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (url.endsWith('/auth/refresh')) return json({ accessToken: 'access-' + ++refreshes, refreshToken: 'refresh-' + refreshes, user });
      if (url.endsWith('/voice/config') && options.method === 'GET') return json(config);
      return handler(url, options);
    }
  });
  assert.deepEqual(await client.getVoiceConfig(), config);
  requests.length = 0;
  return { client, requests };
}

test('App speech uses authenticated server configuration and receives MP3 without sending provider credentials', async () => {
  const { client, requests } = await connected(async () => new Response('mp3', { headers: { 'content-type': 'audio/mpeg' } }));
  const before = getCloudState(), ledger = localDb.readBackupState();
  const blob = await client.synthesizeVoice({ text: '张姐消费38元', provider: 'xfyun', apiKey: 'must-not-send', test: true });
  assert.equal(blob.type, 'audio/mpeg');
  assert.equal(await blob.text(), 'mp3');
  assert.equal(requests[0].url, 'https://member.example.com/api/v1/voice/synthesize');
  assert.equal(requests[0].headers.Authorization, 'Bearer access-1');
  assert.deepEqual(JSON.parse(requests[0].body), { text: '张姐消费38元' });
  assert.deepEqual(getCloudState(), before);
  assert.deepEqual(localDb.readBackupState(), ledger);
});

test('expired App token refreshes and retries synthesis as audio instead of JSON', async () => {
  const { client, requests } = await connected(async (_url, options) => options.headers.Authorization === 'Bearer access-1'
    ? json({ error: '令牌过期' }, 401)
    : new Response('new-mp3', { headers: { 'content-type': 'audio/mpeg' } }));
  assert.equal(await (await client.synthesizeVoice({ text: '充值10元' })).text(), 'new-mp3');
  assert.equal(requests.length, 3);
  assert.ok(requests[1].url.endsWith('/auth/refresh'));
  assert.equal(requests[2].headers.Authorization, 'Bearer access-2');
  assert.equal(requests[0].body, requests[2].body);
});

test('App settings submit authenticated config and only explicit preview requests contain draft credentials', async () => {
  const { client, requests } = await connected(async (url, options) => {
    if (url.endsWith('/users')) return json([{ id: 'owner-1', role: 'owner', active: true }]);
    if (url.endsWith('/voice/config')) return json({ ...JSON.parse(options.body), apiKey: '', hasApiKey: true });
    return new Response('preview-mp3', { headers: { 'content-type': 'audio/mpeg' } });
  });
  assert.equal((await client.getUsers())[0].role, 'owner');
  const saved = await client.saveVoiceConfig({ enabled: true, events: { consume: false, recharge: true }, templates: { consume: '扣款', recharge: '充值' } });
  assert.deepEqual(saved.events, { consume: false, recharge: true });
  const preview = await client.previewVoice({ text: '试听草稿', provider: 'xfyun', appId: 'testappid', apiKey: 'draft-test-only', voiceId: 'aisjinger', aligenie: { token: 'must-not-send' } });
  assert.equal(await preview.text(), 'preview-mp3');
  assert.deepEqual(JSON.parse(requests[2].body), { text: '试听草稿', test: true, provider: 'xfyun', appId: 'testappid', apiKey: 'draft-test-only', voiceId: 'aisjinger' });
  assert.ok(requests.every(request => request.headers.Authorization === 'Bearer access-1'));
});

test('voice provider error remains readable and does not change accounting or synchronization', async () => {
  const { client } = await connected(async () => json({ error: '讯飞额度不足' }, 402));
  const before = client.snapshot();
  await assert.rejects(client.synthesizeVoice({ text: '测试' }), { message: '讯飞额度不足', status: 402 });
  assert.deepEqual(client.snapshot(), before);
});

for (const invalid of ['json', 'empty', 'oversize']) {
  test(`App rejects ${invalid} instead of playing invalid audio`, async () => {
    const { client } = await connected(async () => invalid === 'json' ? json({ error: 'bad response' })
      : new Response(invalid === 'empty' ? '' : new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'audio/mpeg' } }));
    await assert.rejects(client.synthesizeVoice({ text: '测试' }), { message: '语音服务未返回有效音频', status: 502 });
    assert.equal(client.snapshot().online, true);
  });
}

test('App synthesis allows more than 15 seconds and clears the deadline after success', async t => {
  let finish, signal;
  const { client } = await connected(async (_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operation = client.synthesizeVoice({ text: '测试' });
  t.mock.timers.tick(120000);
  assert.equal(signal.aborted, false);
  finish(new Response('mp3', { headers: { 'content-type': 'audio/mpeg' } }));
  assert.equal(await (await operation).text(), 'mp3');
  t.mock.timers.tick(20000);
  assert.equal(signal.aborted, false);
});

for (const cancellation of ['deadline', 'stop']) {
  test(`App synthesis ${cancellation} preserves ledger and login state`, async t => {
    const { client, requests } = await connected(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const before = client.snapshot();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const rejection = assert.rejects(client.synthesizeVoice({ text: '测试' }, { signal: controller.signal }), cancellation === 'stop'
      ? { code: 'VOICE_CANCELLED' } : { status: 504, message: '语音合成等待超时，请稍后重试' });
    if (cancellation === 'stop') controller.abort(); else t.mock.timers.tick(130000);
    await rejection;
    assert.deepEqual(client.snapshot(), before);
    assert.equal(requests.length, 1);
  });
}

test('App automatic announcements require an online bound login and use the same saved config', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = { serverUrl: 'https://member.example.com', user: { id: 'user-1' }, binding: { storeId: 'store-1' }, online: true, syncLoginRequired: false };
  let current = state;
  t.mock.method(cloudClient, 'snapshot', () => current);
  const getConfig = t.mock.method(cloudClient, 'getVoiceConfig', async () => config);
  const synthesis = t.mock.method(cloudClient, 'synthesizeVoice', async () => new Blob(['mp3'], { type: 'audio/mpeg' }));
  const playback = t.mock.method(appVoicePlayer, 'playAudioUrl', async () => {});
  appVoicePlayer.stop();
  t.after(() => appVoicePlayer.stop());
  for (const patch of [{ user: null }, { binding: null }, { online: false }, { syncLoginRequired: true }]) {
    current = { ...state, ...patch };
    assert.equal(await appVoicePlayer.broadcast('consume', { name: '张姐', amount: '38.00' }), false);
  }
  assert.equal(getConfig.mock.callCount(), 0);
  current = state;
  assert.equal(await appVoicePlayer.broadcast('consume', { name: '张姐', amount: '38.00' }), true);
  assert.equal(synthesis.mock.callCount(), 1);
  assert.deepEqual(synthesis.mock.calls[0].arguments[0], { text: '张姐消费38元' });
  assert.equal(playback.mock.callCount(), 1);
});
