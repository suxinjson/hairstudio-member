import { ApiError } from './security.js';
import { createVoiceWebSocket } from './voice-network.js';

export async function synthesizeXfyun({ apiUrl, apiKey, appId, voiceId, text, signal, socketFn }) {
  const socket = await createVoiceWebSocket({ socketFn })(apiUrl, { headers: { 'x-api-key': apiKey }, signal });
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, frames = 0, responseSize = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      socket.removeListener('open', onOpen); socket.removeListener('message', onMessage);
      socket.removeListener('close', onClose); socket.removeListener('error', onError);
      socket.removeListener('unexpected-response', onUnexpected);
      // Closing a failed handshake can emit one last transport error.
      socket.on('error', () => {});
      socket.terminate();
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => finish(signal.reason);
    const onError = error => finish(error);
    const onClose = () => finish(new ApiError(502, '讯飞连接提前关闭，未收到完整音频', 'VOICE_UPSTREAM_FAILED'));
    const onUnexpected = (_request, response) => {
      response.destroy();
      finish(new ApiError(502, `讯飞握手失败 (${response.statusCode})，请检查 APIPassword、应用授权和 IP 白名单`, 'VOICE_UPSTREAM_ERROR'));
    };
    const onOpen = () => {
      try {
        socket.send(JSON.stringify({
          common: { app_id: appId },
          business: { aue: 'lame', sfl: 1, auf: 'audio/L16;rate=16000', vcn: voiceId, tte: 'UTF8', speed: 50, volume: 50, pitch: 50 },
          data: { status: 2, text: Buffer.from(text, 'utf8').toString('base64') }
        }), error => { if (error) finish(error); });
      } catch (error) { finish(error); }
    };
    const onMessage = (message, isBinary) => {
      if (settled) return;
      try {
        responseSize += Buffer.byteLength(message);
        if (++frames > 4096 || responseSize > 18 * 1024 * 1024 || Buffer.byteLength(message) > 1024 * 1024) {
          throw new ApiError(502, '讯飞响应超过大小限制', 'VOICE_RESPONSE_LIMIT');
        }
        if (isBinary) throw new ApiError(502, '讯飞返回了不支持的音频协议');
        const data = JSON.parse(message.toString());
        if (data.code !== 0) {
          const hints = { 10005: '请检查 APPID 和在线语音合成授权', 11200: '请在控制台开通当前发音人', 11201: '服务量或每日调用额度不足，请检查控制台额度', 11202: '请求过于频繁，请稍后重试', 11203: '并发调用过多，请稍后重试' };
          const code = Number.isInteger(data.code) ? data.code : 'INVALID';
          throw new ApiError(502, `讯飞接口错误 (${code})：${hints[code] || '请检查应用、发音人授权和剩余服务量'}`, 'VOICE_UPSTREAM_ERROR');
        }
        if (!data.data) return; // The API can send successful empty frames.
        const { audio, status } = data.data;
        if (audio !== undefined && audio !== '') {
          if (typeof audio !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio)) throw new ApiError(502, '讯飞返回了无效的音频编码');
          const chunk = Buffer.from(audio, 'base64'); size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new ApiError(502, '讯飞音频超过大小限制', 'VOICE_RESPONSE_LIMIT');
          chunks.push(chunk);
        }
        if (status === 2) {
          if (!size) throw new ApiError(502, '讯飞未返回有效音频');
          finish(null, { buffer: Buffer.concat(chunks, size), contentType: 'audio/mpeg' });
        }
      } catch (error) {
        finish(error instanceof SyntaxError ? new ApiError(502, '讯飞返回了无效的 JSON 响应') : error);
      }
    };
    socket.once('open', onOpen); socket.on('message', onMessage);
    socket.once('error', onError); socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpected);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (socket.readyState === 1) onOpen();
  });
}
