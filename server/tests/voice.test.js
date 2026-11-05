import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../database.js';
import { createService } from '../service.js';
import { createApi } from '../http.js';
import { sanitizeVoiceConfig, maskApiKey, synthesizeTTS } from '../voice.js';
import { randomUUID } from 'node:crypto';

test('voice configuration sanitization and key masking', () => {
  const masked = maskApiKey('sk-fish-12345678abcdef');
  assert.equal(masked, 'sk-f****cdef');
  assert.equal(maskApiKey(''), '');
  assert.equal(maskApiKey('1234'), '****');

  const config = sanitizeVoiceConfig({
    enabled: true,
    provider: 'heygen',
    apiUrl: 'https://api.heygen.com/v3/models/audio/tts',
    apiKey: 'sk_test_key_12345',
    model: 'heygen-voice-1-turbo-free',
    voiceId: '83548de556df48ba8c09c42a57c51d85',
    volume: 0.8
  });
  assert.equal(config.enabled, true);
  assert.equal(config.provider, 'heygen');
  assert.equal(config.apiKey, 'sk_test_key_12345');
  assert.equal(config.volume, 0.8);

  // Masked key in input does not overwrite existing key
  const updated = sanitizeVoiceConfig({
    apiKey: 'sk-t****2345',
    volume: 0.9
  }, config);
  assert.equal(updated.apiKey, 'sk_test_key_12345');
  assert.equal(updated.volume, 0.9);

  // Clear key
  const cleared = sanitizeVoiceConfig({ clearApiKey: true }, updated);
  assert.equal(cleared.apiKey, '');
});

test('Fish Audio TTS synthesis sends correct format and headers', async () => {
  let capturedUrl, capturedHeaders, capturedBody;
  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);
    const bytes = new TextEncoder().encode('FAKE-MP3-AUDIO-DATA');
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => bytes.buffer
    };
  };

  const result = await synthesizeTTS({
    provider: 'fish_audio',
    apiUrl: 'https://api.fish.audio/v1/tts',
    apiKey: 'sk-fish-mytestkey',
    model: 's2.1-pro-free',
    voiceId: 'ref-123',
    text: '张三消费50元',
    fetchFn: mockFetch
  });

  assert.equal(capturedUrl, 'https://api.fish.audio/v1/tts');
  assert.equal(capturedHeaders['Authorization'], 'Bearer sk-fish-mytestkey');
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
  assert.equal(capturedHeaders['model'], 's2.1-pro-free');
  assert.equal(capturedBody.text, '张三消费50元');
  assert.equal(capturedBody.reference_id, 'ref-123');
  assert.equal(capturedBody.format, 'mp3');
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.buffer.toString(), 'FAKE-MP3-AUDIO-DATA');
});

test('HeyGen TTS synthesis requests audio URL and downloads audio stream', async () => {
  let heygenReq, downloadReq;
  const mockFetch = async (url, options) => {
    if (url === 'https://api.heygen.com/v3/models/audio/tts') {
      heygenReq = { url, headers: options.headers, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          data: {
            audio_url: 'https://resource2.heygen.ai/audio/sample.wav',
            duration: 3.5
          }
        })
      };
    }
    if (url === 'https://resource2.heygen.ai/audio/sample.wav') {
      downloadReq = { url };
      const bytes = new TextEncoder().encode('FAKE-WAV-AUDIO-DATA');
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/wav' }),
        arrayBuffer: async () => bytes.buffer
      };
    }
    throw new Error('Unknown URL: ' + url);
  };

  const result = await synthesizeTTS({
    provider: 'heygen',
    apiUrl: 'https://api.heygen.com/v3/models/audio/tts',
    apiKey: 'sk_heygen_key',
    model: 'heygen-voice-1-turbo-free',
    voiceId: 'voice-456',
    text: '李四充值100元',
    fetchFn: mockFetch
  });

  assert.equal(heygenReq.headers['X-Api-Key'], 'sk_heygen_key');
  assert.equal(heygenReq.body.model, 'heygen-voice-1-turbo-free');
  assert.equal(heygenReq.body.voice_id, 'voice-456');
  assert.equal(heygenReq.body.text, '李四充值100元');
  assert.equal(heygenReq.body.language, 'zh');
  assert.equal(downloadReq.url, 'https://resource2.heygen.ai/audio/sample.wav');
  assert.equal(result.contentType, 'audio/wav');
  assert.equal(result.buffer.toString(), 'FAKE-WAV-AUDIO-DATA');
});

test('Voice configuration endpoints and synthesis API security and flow', async () => {
  const db = new PGlite();
  const pool = {
    query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql),
    connect: async () => ({ query: (sql, params) => params ? db.query(sql, params) : sql.includes(';') ? db.exec(sql) : db.query(sql), release() {} })
  };
  await migrate(pool);

  let synthesizedText = null;
  const mockFetch = async (url, options) => {
    synthesizedText = JSON.parse(options.body).text;
    const bytes = new TextEncoder().encode('TEST-BROADCAST');
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => bytes.buffer
    };
  };

  const service = createService(pool, { fetchFn: mockFetch });
  const server = createApi({ service, pool, production: false });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Create owner and login
    const ownerInfo = await service.createOwner({ username: 'shopowner', password: 'OwnerPassword123!' });
    const ownerLogin = await (await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'shopowner', password: 'OwnerPassword123!', deviceId: randomUUID() })
    })).json();
    const ownerToken = ownerLogin.accessToken;

    // 2. Create clerk
    const clerkUser = await service.createUser(await service.authenticate(ownerToken), {
      username: 'cashier1',
      password: 'ClerkPassword123!',
      displayName: '前台收银',
      role: 'clerk'
    });
    const clerkLogin = await (await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'cashier1', password: 'ClerkPassword123!', deviceId: randomUUID() })
    })).json();
    const clerkToken = clerkLogin.accessToken;

    // 3. Initial voice config should have defaults
    const initialConfigRes = await fetch(`${baseUrl}/api/v1/voice/config`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(initialConfigRes.status, 200);
    const initialConfig = await initialConfigRes.json();
    assert.equal(initialConfig.enabled, false);
    assert.equal(initialConfig.provider, 'fish_audio');
    assert.equal(initialConfig.hasApiKey, false);

    // 4. Clerk cannot save voice config (403 Forbidden)
    const clerkSaveRes = await fetch(`${baseUrl}/api/v1/voice/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clerkToken}` },
      body: JSON.stringify({ enabled: true, apiKey: 'sk-clerk-hack' })
    });
    assert.equal(clerkSaveRes.status, 403);

    // 5. Owner saves voice config
    const ownerSaveRes = await fetch(`${baseUrl}/api/v1/voice/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        enabled: true,
        provider: 'fish_audio',
        apiKey: 'sk-fish-valid-key-12345678',
        model: 's2.1-pro-free',
        voiceId: '74c6aba5cbf94a15bbdc547ffce5cb38'
      })
    });
    assert.equal(ownerSaveRes.status, 200);
    const savedData = await ownerSaveRes.json();
    assert.equal(savedData.enabled, true);
    assert.equal(savedData.apiKey, 'sk-fish-valid-key-12345678');
    assert.equal(savedData.hasApiKey, true);

    // 6. Clerk reads voice config: apiKey must be masked
    const clerkReadRes = await fetch(`${baseUrl}/api/v1/voice/config`, {
      headers: { Authorization: `Bearer ${clerkToken}` }
    });
    const clerkConfig = await clerkReadRes.json();
    assert.equal(clerkConfig.enabled, true);
    assert.equal(clerkConfig.hasApiKey, true);
    assert.equal(clerkConfig.apiKey, 'sk-f****5678');

    // 7. Synthesize voice through API proxy
    const synthRes = await fetch(`${baseUrl}/api/v1/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clerkToken}` },
      body: JSON.stringify({ text: '张三消费50元，卡内余额150元' })
    });
    assert.equal(synthRes.status, 200);
    assert.equal(synthRes.headers.get('content-type'), 'audio/mpeg');
    const audioBuf = await synthRes.arrayBuffer();
    assert.equal(Buffer.from(audioBuf).toString(), 'TEST-BROADCAST');
    assert.equal(synthesizedText, '张三消费50元，卡内余额150元');

    // 8. Owner testing with draft parameters
    const ownerTestRes = await fetch(`${baseUrl}/api/v1/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        text: '试听测试文本',
        test: true,
        provider: 'fish_audio'
      })
    });
    assert.equal(ownerTestRes.status, 200);
    assert.equal(synthesizedText, '试听测试文本');
  } finally {
    server.close();
    await db.close();
  }
});
