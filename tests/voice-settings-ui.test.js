import test, { before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { vueUi } from './helpers/vue-ui.mjs';

let ui, Voice;
before(async t => {
  ui = await vueUi(t);
  Voice = await ui.component(new URL('../src/components/VoiceSettings.vue', import.meta.url));
});
afterEach(() => ui.unmount());
async function settle() { for (let i = 0; i < 8; i++) { await new Promise(resolve => setImmediate(resolve)); await ui.nextTick(); } }
function fixture() {
  const calls = [];
  return { calls, user: { role: 'owner' },
    api: { getVoiceConfig: async () => ({ version: 0, provider: 'fish_audio', voiceId: '', hasApiKey: true, enabled: false }), getUsers: async () => [],
      async saveVoiceConfig(config, version) { calls.push({ config, version }); return { ...config, version: version + 1, hasApiKey: true }; } },
    player: { preparePlayback() { calls.push('prepare'); }, stop() { calls.push('stop'); }, async queueSpeak(text, options) { calls.push({ text, options }); } }
  };
}

test('voice preview activates playback on click and preserves a blank Fish voice through preview and save', async () => {
  const f = fixture();
  await ui.mount(Voice, f); await settle();
  assert.equal(document.querySelector('[aria-label="播报音色"]').value, '');
  ui.button('试听测试').click(); await settle();
  assert.equal(f.calls[0], 'prepare');
  assert.equal(f.calls[1].options.testOptions.voiceId, '');
  assert.equal(f.calls[1].options.testOptions.model, 's2.1-pro-free');
  ui.button('保存播报配置').click(); await settle();
  const saved = f.calls.find(call => call.config);
  assert.equal(saved.config.voiceId, '');
  assert.equal(saved.version, 0);
});

test('blocked voice preview offers playback retry and tracks its actual playing state without resynthesizing', async () => {
  const f = fixture(); let requests = 0, retries = 0, finish;
  f.player.queueSpeak = async () => {
    requests++;
    throw Object.assign(new Error('音频已合成，浏览器阻止了自动播放'), { code: 'VOICE_PLAYBACK_BLOCKED', retryPlayback: ({ onStatus }) => {
      retries++; onStatus('playing'); return new Promise(resolve => { finish = resolve; });
    } });
  };
  await ui.mount(Voice, f); await settle();
  ui.button('试听测试').click(); await settle();
  assert.match(document.body.textContent, /浏览器阻止了自动播放/);
  ui.button('播放已合成音频').click(); await settle();
  assert.equal(ui.button('正在播放试听').disabled, true);
  assert.equal(requests, 1); assert.equal(retries, 1);
  finish(); await settle();
  assert.match(document.body.textContent, /音频合成并播放成功/);
  assert.equal(ui.button('试听测试').disabled, false);
});

test('editing the preview discards the old blocked audio and synthesizes the new text', async () => {
  const f = fixture(); let requests = 0;
  f.player.queueSpeak = async () => {
    requests++;
    throw Object.assign(new Error('blocked'), { code: 'VOICE_PLAYBACK_BLOCKED', retryPlayback: () => { throw new Error('stale retry'); } });
  };
  await ui.mount(Voice, f); await settle();
  ui.button('试听测试').click(); await settle();
  assert.ok(ui.button('播放已合成音频'));
  await ui.input('[aria-label="试听文本"]', '新的试听文本');
  ui.button('试听测试').click(); await settle();
  assert.equal(requests, 2);
});

test('editing an in-flight preview cancels it and ignores its late completion', async () => {
  const f = fixture(), requests = [], completions = [];
  f.player.queueSpeak = (text, options) => {
    requests.push({ text, options });
    return new Promise(resolve => completions.push(resolve));
  };
  await ui.mount(Voice, f); await settle();
  ui.button('试听测试').click(); await settle();
  assert.ok(ui.button('正在合成试听'));
  await ui.input('[aria-label="试听文本"]', '更新后的试听内容');
  assert.equal(f.calls.filter(call => call === 'stop').length, 1);
  assert.equal(ui.button('试听测试').disabled, false);
  completions[0](); await settle();
  assert.equal(document.body.textContent.includes('音频合成并播放成功'), false);
  ui.button('试听测试').click(); await settle();
  assert.equal(requests[1].text, '更新后的试听内容');
  completions[1](); await settle();
  assert.match(document.body.textContent, /音频合成并播放成功/);
});
