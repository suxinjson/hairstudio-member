import test from 'node:test';
import assert from 'node:assert/strict';
import { voicePlayer } from '../admin/src/utils/voice-player.js';
import { AdminApiClient } from '../admin/src/api/client.js';

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
