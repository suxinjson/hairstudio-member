import test from 'node:test';
import assert from 'node:assert/strict';
import { voicePlayer } from '../admin/src/utils/voice-player.js';
import { AdminApiClient } from '../admin/src/api/client.js';
import { VoicePlayer } from '../src/voice-player.js';

const memoryStorage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
};

test('voicePlayer template variable replacement', () => {
  const tpl = '{name} 消费 {amount} 元，卡内余额 {balance} 元（{store}）';
  const result = voicePlayer.formatTemplate(tpl, {
    name: '张三',
    amount: '88.00',
    balance: '200.00',
    store: '梦飞空间'
  });
  assert.equal(result, '张三 消费 88.00 元，卡内余额 200.00 元（梦飞空间）');

  // Missing variable remains untouched or handles safely
  const partial = voicePlayer.formatTemplate('{name} 充值 {amount} 元', { name: '李四' });
  assert.equal(partial, '李四 充值 {amount} 元');
});

test('AdminApiClient voice configuration and synthesis methods', async () => {
  const requests = [];
  const fakeStorage = new Map();
  const mockStorage = {
    getItem: k => fakeStorage.get(k) ?? null,
    setItem: (k, v) => fakeStorage.set(k, String(v)),
    removeItem: k => fakeStorage.delete(k)
  };

  const client = new AdminApiClient({
    storage: mockStorage,
    fetch: async (path, options) => {
      requests.push({ path, ...options });
      if (path === '/api/v1/voice/config' && !options?.method) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            provider: 'fish_audio',
            apiUrl: '',
            apiKey: 'sk-f****1234',
            model: 's2.1-pro-free',
            voiceId: 'ref-1',
            hasApiKey: true,
            templates: {
              consume: '{name} 消费 {amount} 元',
              recharge: '{name} 充值 {amount} 元'
            }
          })
        };
      }
      if (path === '/api/v1/voice/config' && options?.method === 'POST') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...body,
            hasApiKey: Boolean(body.apiKey)
          })
        };
      }
      if (path === '/api/v1/voice/synthesize') {
        const body = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([`AUDIO:${body.text}`], { type: 'audio/mpeg' })
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: 'Not found' }) };
    }
  });

  client.saveSession({
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    user: { id: 'user-1', storeId: 'store-1', role: 'owner' }
  });

  // 1. Get voice config
  const config = await client.getVoiceConfig();
  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'fish_audio');
  assert.equal(config.hasApiKey, true);

  // 2. Save voice config
  const saved = await client.saveVoiceConfig({
    enabled: true,
    provider: 'heygen',
    apiKey: 'sk_heygen_new_key'
  });
  assert.equal(saved.provider, 'heygen');
  assert.equal(saved.hasApiKey, true);

  // 3. Synthesize voice
  const blob = await client.synthesizeVoice({ text: '测试播报文本' });
  assert.ok(blob);
  const text = await blob.text();
  assert.equal(text, 'AUDIO:测试播报文本');
});

test('admin voice preview can wait for both HeyGen phases before timing out', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, finish;
  const client = new AdminApiClient({ storage: memoryStorage(), eventTarget: null, fetch: async (_path, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  t.after(() => client.dispose());
  const operation = client.synthesizeVoice({ provider: 'heygen', text: '测试' });
  t.mock.timers.tick(120000); assert.equal(signal.aborted, false);
  finish(new Response('audio', { headers: { 'content-type': 'audio/wav' } }));
  assert.equal(await (await operation).text(), 'audio');
  t.mock.timers.tick(20000); assert.equal(signal.aborted, false);
});

test('admin voice preview gives a readable timeout error and does not refresh login on timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new AdminApiClient({ storage: memoryStorage(), eventTarget: null, fetch: async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  t.after(() => client.dispose());
  const refresh = t.mock.method(client, 'refresh', async () => { throw new Error('unexpected refresh'); });
  const rejected = assert.rejects(client.synthesizeVoice({ text: '测试' }), /语音合成等待超时/);
  t.mock.timers.tick(130000); await rejected;
  assert.equal(refresh.mock.callCount(), 0);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function audioHarness(t) {
  const instances = [], urls = [], revoked = [];
  const previous = globalThis.Audio;
  globalThis.Audio = class extends EventTarget {
    constructor() { super(); instances.push(this); }
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
    removeAttribute(name) { delete this[name]; }
    load() { this.released = true; }
  };
  t.after(() => { if (previous === undefined) delete globalThis.Audio; else globalThis.Audio = previous; });
  t.mock.method(URL, 'createObjectURL', blob => { urls.push(blob); return 'blob:test-' + urls.length; });
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  return { instances, urls, revoked };
}

test('shared announcements use saved templates and volume and cache config by login context', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let context = 'store-A';
  const calls = [], audio = audioHarness(t);
  const getVoiceConfig = t.mock.fn(async () => ({ enabled: true, volume: 0.4, templates: { consume: '{name}消费{amount}元，余额{balance}元' } }));
  const player = new VoicePlayer({ context: () => context, api: {
    getVoiceConfig,
    synthesizeVoice: async options => { calls.push(options); return new Blob(['mp3'], { type: 'audio/mpeg' }); }
  } });
  t.after(() => player.stop());
  for (let i = 0; i < 3; i++) {
    if (i === 2) context = 'store-B';
    const operation = player.broadcast('consume', { name: '张姐', amount: '38.00', balance: '62.00' });
    await flush();
    assert.equal(audio.instances[i].volume, 0.4);
    audio.instances[i].dispatchEvent(new Event('ended'));
    assert.equal(await operation, true);
  }
  assert.equal(getVoiceConfig.mock.callCount(), 2);
  assert.deepEqual(calls, Array(3).fill({ text: '张姐消费38.00元，余额62.00元' }));
  assert.equal(audio.revoked.length, 3);
  assert.ok(audio.instances.every(instance => instance.paused && instance.released && !instance.src));
});

test('disabled or unavailable announcements make no synthesis requests', async t => {
  const synthesizeVoice = t.mock.fn(async () => { throw new Error('unexpected synthesis'); });
  const getVoiceConfig = t.mock.fn(async () => ({ enabled: false }));
  let available = false;
  const player = new VoicePlayer({ api: { getVoiceConfig, synthesizeVoice }, canBroadcast: () => available });
  assert.equal(await player.broadcast('consume'), false);
  assert.equal(getVoiceConfig.mock.callCount(), 0);
  available = true;
  assert.equal(await player.broadcast('consume'), false);
  assert.equal(getVoiceConfig.mock.callCount(), 1);
  assert.equal(synthesizeVoice.mock.callCount(), 0);
});

test('saved per-event switches skip consumption while still playing recharge', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const synthesis = t.mock.fn(async () => new Blob(['mp3'], { type: 'audio/mpeg' }));
  const player = new VoicePlayer({ api: {
    getVoiceConfig: async () => ({ enabled: true, events: { consume: false, recharge: true }, templates: { consume: '扣款', recharge: '充值' } }),
    synthesizeVoice: synthesis
  } });
  t.mock.method(player, 'playAudioUrl', async () => {});
  assert.equal(await player.broadcast('consume'), false);
  assert.equal(synthesis.mock.callCount(), 0);
  assert.equal(await player.broadcast('recharge'), true);
  assert.deepEqual(synthesis.mock.calls[0].arguments[0], { text: '充值' });
});

test('announcements play sequentially and stop releases active and queued audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = audioHarness(t), calls = [];
  const player = new VoicePlayer({ api: { synthesizeVoice: async options => {
    calls.push(options.text); return new Blob(['mp3'], { type: 'audio/mpeg' });
  } } });
  const first = player.queueSpeak('第一笔'), second = player.queueSpeak('第二笔');
  await flush();
  assert.deepEqual(calls, ['第一笔']);
  audio.instances[0].dispatchEvent(new Event('ended'));
  await first;
  t.mock.timers.tick(300); await flush();
  assert.deepEqual(calls, ['第一笔', '第二笔']);
  const third = player.queueSpeak('第三笔');
  const stopped = Promise.all([second, third].map(operation => assert.rejects(operation, { code: 'VOICE_CANCELLED' })));
  player.stop(); await stopped; await flush();
  assert.equal(audio.revoked.length, 2);
  assert.ok(audio.instances[1].paused && audio.instances[1].released);
  t.mock.timers.tick(300); await flush();
  assert.deepEqual(calls, ['第一笔', '第二笔']);
});

test('stopping pending synthesis cancels late audio and a later announcement still plays', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = audioHarness(t), pending = deferred();
  let signal, count = 0;
  const player = new VoicePlayer({ api: { synthesizeVoice: async (_options, options) => {
    if (++count === 1) { signal = options.signal; return pending.promise; }
    return new Blob(['next'], { type: 'audio/mpeg' });
  } } });
  const first = player.queueSpeak('旧请求');
  const rejected = assert.rejects(first, { code: 'VOICE_CANCELLED' });
  player.stop(); await rejected;
  assert.equal(signal.aborted, true);
  const second = player.queueSpeak('新请求');
  pending.resolve(new Blob(['late'], { type: 'audio/mpeg' }));
  await flush();
  assert.equal(audio.urls.length, 0);
  t.mock.timers.tick(300); await flush();
  assert.equal(audio.urls.length, 1);
  assert.equal(await audio.urls[0].text(), 'next');
  audio.instances[0].dispatchEvent(new Event('ended')); await second;
});

for (const change of ['stop', 'context']) {
  test(`${change} during config fetch cannot restore old config or start playback`, async t => {
    const pending = deferred(); let context = 'old';
    const synthesizeVoice = t.mock.fn(async () => {}), onError = t.mock.fn();
    const player = new VoicePlayer({ context: () => context, api: { getVoiceConfig: () => pending.promise, synthesizeVoice } });
    const operation = player.broadcast('consume', {}, { onError });
    if (change === 'stop') player.stop(); else context = 'new';
    pending.resolve({ enabled: true, templates: { consume: '旧门店消费' } });
    assert.equal(await operation, false);
    assert.equal(player.cachedConfig, null);
    assert.equal(synthesizeVoice.mock.callCount(), 0);
    assert.equal(onError.mock.callCount(), 0);
  });
}

test('playback failure reports an error and frees audio so later transactions can announce', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const audio = audioHarness(t), errors = [];
  const player = new VoicePlayer({ api: {
    getVoiceConfig: async () => ({ enabled: true, templates: { recharge: '{amount}' } }),
    synthesizeVoice: async () => new Blob(['mp3'], { type: 'audio/mpeg' })
  } });
  const first = player.broadcast('recharge', { amount: '10.00' }, { onError: error => errors.push(error.message) });
  await flush(); audio.instances[0].dispatchEvent(new Event('error'));
  assert.equal(await first, false);
  assert.deepEqual(errors, ['音频解码或播放失败']);
  assert.deepEqual(audio.revoked, ['blob:test-1']);
  const second = player.broadcast('recharge', { amount: '20.00' });
  await flush(); audio.instances[1].dispatchEvent(new Event('ended'));
  assert.equal(await second, true);
});

test('admin synthesis cancellation does not refresh login or become a timeout', async t => {
  const controller = new AbortController();
  const client = new AdminApiClient({ storage: memoryStorage(), eventTarget: null, fetch: async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  }) });
  t.after(() => client.dispose());
  const refresh = t.mock.method(client, 'refresh', async () => { throw new Error('unexpected refresh'); });
  const rejected = assert.rejects(client.synthesizeVoice({ text: '测试' }, { signal: controller.signal }), { code: 'VOICE_CANCELLED' });
  controller.abort(); await rejected;
  assert.equal(refresh.mock.callCount(), 0);
});
