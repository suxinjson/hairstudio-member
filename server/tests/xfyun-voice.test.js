import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { synthesizeTTS, sanitizeVoiceConfig, readVoiceConfig, publicVoiceConfig, PROVIDER_DEFAULTS } from '../voice.js';
import { assertVoiceWebSocketUrl, createVoiceWebSocket } from '../voice-network.js';

class VoiceSocket extends EventEmitter {
  readyState = 1;
  terminated = false;
  constructor(reply = () => {}) { super(); this.reply = reply; }
  send(body, callback) { this.request = JSON.parse(body); callback?.(); this.reply(this); }
  frame(data) { this.emit('message', Buffer.from(JSON.stringify(data)), false); }
  terminate() { this.terminated = true; }
}
const options = { provider: 'xfyun', appId: 'testappid', apiKey: 'ak-test-only-password', text: '张三消费50元，余额100元' };
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('Xfyun receives normalized money from installed App requests before UTF-8 encoding', async () => {
  const socket = new VoiceSocket(socket => socket.frame({ code: 0, data: { status: 2, audio: 'YXVkaW8=' } }));
  await synthesizeTTS({ ...options, text: '张三消费38.00元，赠送0.50元，余额-0.05元', socketFn: async () => socket });
  assert.equal(Buffer.from(socket.request.data.text, 'base64').toString('utf8'), '张三消费38元，赠送0.5元，余额-0.05元');
});

test('Xfyun password authentication sends UTF-8 text, app ID and voice, and joins MP3 chunks', async () => {
  const socket = new VoiceSocket(socket => {
    socket.frame({ code: 0, data: null });
    socket.frame({ code: 0, data: { status: 1, audio: Buffer.from('first-').toString('base64') } });
    socket.frame({ code: 0, data: { status: 2, audio: Buffer.from('second').toString('base64') } });
  });
  const result = await synthesizeTTS({ ...options, socketFn: async (url, request) => {
    assert.equal(url, PROVIDER_DEFAULTS.xfyun.apiUrl);
    assert.deepEqual(request.headers, { 'x-api-key': options.apiKey });
    assert.equal(new URL(url).search, '');
    return socket;
  } });
  assert.equal(socket.request.common.app_id, options.appId);
  assert.equal(socket.request.business.vcn, 'x4_xiaoyan');
  assert.equal(socket.request.business.aue, 'lame'); assert.equal(socket.request.business.sfl, 1);
  assert.equal(socket.request.business.tte, 'UTF8');
  assert.equal(socket.request.data.status, 2);
  assert.equal(Buffer.from(socket.request.data.text, 'base64').toString('utf8'), options.text);
  assert.equal(result.contentType, 'audio/mpeg'); assert.equal(result.buffer.toString(), 'first-second');
  assert.equal(socket.terminated, true); assert.equal(socket.listenerCount('message'), 0);
});

test('Xfyun validation and public config preserve server credentials without exposing passwords', async t => {
  const previous = { XFYUN_API_PASSWORD: process.env.XFYUN_API_PASSWORD, XFYUN_APP_ID: process.env.XFYUN_APP_ID };
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.XFYUN_API_PASSWORD = 'ak-server-test-password';
  process.env.XFYUN_APP_ID = 'serverappid';
  const config = readVoiceConfig(sanitizeVoiceConfig({ provider: 'xfyun' }));
  const publicConfig = publicVoiceConfig(config, 'owner');
  assert.equal(publicConfig.hasApiKey, true); assert.equal(publicConfig.serverXfyunConfigured, true);
  assert.equal(publicConfig.appId, 'serverappid'); assert.equal(publicConfig.apiKey, '');
  assert.equal(JSON.stringify(publicConfig).includes(process.env.XFYUN_API_PASSWORD), false);
  assert.equal(publicVoiceConfig(config, 'clerk').appId, undefined);
  const socket = new VoiceSocket(socket => socket.frame({ code: 0, data: { status: 2, audio: 'YXVkaW8=' } }));
  await synthesizeTTS({ provider: 'xfyun', text: '测试', socketFn: async (_url, request) => {
    assert.equal(request.headers['x-api-key'], 'ak-server-test-password'); return socket;
  } });
  assert.equal(socket.request.common.app_id, 'serverappid');
  assert.throws(() => sanitizeVoiceConfig({ provider: 'xfyun', appId: 'bad id' }), /APPID/);
});

test('Xfyun secure transport denies unauthorized origins and pins validated public DNS', async () => {
  for (const url of ['ws://tts-api.xfyun.cn/v2/tts', 'wss://127.0.0.1/v2/tts', 'wss://tts-api.xfyun.cn@evil.example/', 'https://tts-api.xfyun.cn/v2/tts']) {
    assert.throws(() => assertVoiceWebSocketUrl(url));
  }
  let captured;
  class PinnedSocket {
    constructor(url, options) { captured = { url, options }; }
  }
  await createVoiceWebSocket({ resolve: async () => [{ address: '8.8.8.8', family: 4 }], WebSocketClass: PinnedSocket })(PROVIDER_DEFAULTS.xfyun.apiUrl);
  assert.equal(captured.url.hostname, 'tts-api.xfyun.cn');
  assert.equal(captured.options.followRedirects, false); assert.equal(captured.options.agent, false);
  assert.equal(captured.options.rejectUnauthorized, undefined);
  captured.options.lookup('tts-api.xfyun.cn', {}, (_error, address, family) => {
    assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  await assert.rejects(createVoiceWebSocket({ resolve: async () => [{ address: '10.0.0.1', family: 4 }] })(PROVIDER_DEFAULTS.xfyun.apiUrl), { code: 'VOICE_TARGET_FORBIDDEN' });
  const controller = new AbortController();
  const pending = createVoiceWebSocket({ resolve: () => new Promise(() => {}) })(PROVIDER_DEFAULTS.xfyun.apiUrl, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});

test('Xfyun synthesis timeout terminates stalled sockets', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new VoiceSocket();
  const rejected = assert.rejects(synthesizeTTS({ ...options, socketFn: async () => socket }), { status: 504, code: 'VOICE_UPSTREAM_TIMEOUT' });
  await tick(); t.mock.timers.tick(60000); await rejected;
  assert.equal(socket.terminated, true); assert.equal(socket.listenerCount('message'), 0);
});

test('Xfyun rejects errors, incomplete audio, malformed frames and empty final responses', async () => {
  for (const [reply, message] of [
    [socket => socket.frame({ code: 11200, message: 'secret-from-upstream' }), /发音人/],
    [socket => socket.frame({ code: 11201 }), /服务量/],
    [socket => socket.emit('close'), /提前关闭/],
    [socket => socket.emit('message', Buffer.from('{broken'), false), /JSON/],
    [socket => socket.frame({ code: 0, data: { status: 2, audio: '' } }), /有效音频/],
    [socket => socket.frame({ code: 0, data: { status: 2, audio: 'invalid$' } }), /编码/],
    [socket => socket.emit('message', Buffer.from('binary'), true), /协议/]
  ]) {
    const socket = new VoiceSocket(reply);
    await assert.rejects(synthesizeTTS({ ...options, socketFn: async () => socket }), error => {
      assert.equal(error.status, 502); assert.match(error.message, message);
      assert.equal(error.message.includes('secret-from-upstream'), false); return true;
    });
    assert.equal(socket.terminated, true);
  }
});

test('Xfyun caps cumulative audio and JSON frame sizes', async () => {
  for (const reply of [
    socket => socket.emit('message', Buffer.alloc(1024 * 1024 + 1), false),
    socket => { const audio = Buffer.alloc(512 * 1024).toString('base64'); for (let i = 0; i < 17; i++) socket.frame({ code: 0, data: { status: 1, audio } }); }
  ]) {
    const socket = new VoiceSocket(reply);
    await assert.rejects(synthesizeTTS({ ...options, socketFn: async () => socket }), { code: 'VOICE_RESPONSE_LIMIT' });
    assert.equal(socket.terminated, true);
  }
});
