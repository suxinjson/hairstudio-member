import { Capacitor, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { createCloudClient, normalizeServerUrl, sha256 } from './cloud-client.js';
import { localDb } from './storage.js';
import { createWebClient } from './web-client.js';
import { createDeviceAccess } from './device-access.js';
const device = registerPlugin('CloudDevice');
function createNativeClient() {
let deviceFingerprint = null, deviceName = '';
const deviceAccess = createDeviceAccess({ vault: {
  async load() { const { access } = await device.loadAccess(); return access ? JSON.parse(access) : null; },
  async save(access) { await device.saveAccess({ access: JSON.stringify(access) }); }
} });
return createCloudClient({
  allowOffline: () => Capacitor.isNativePlatform(),
  deviceAccess,
  async getDeviceId(legacyId) { const identity = await device.getDeviceId({ legacyId }); deviceFingerprint = identity.deviceFingerprint; deviceName = identity.deviceName; return identity.deviceId; },
  getDeviceFingerprint: () => deviceFingerprint,
  getDeviceName: () => deviceName,
  vault: {
    async load() { if (!Capacitor.isNativePlatform()) return null; const { session } = await device.loadSession(); return session ? JSON.parse(session) : null; },
    async save(session) { if (Capacitor.isNativePlatform()) await device.saveSession({ session: JSON.stringify(session) }); },
    async clear() { if (Capacitor.isNativePlatform()) await device.clearSession(); }
  },
  onData: () => { if (globalThis.window) window.dispatchEvent(new window.Event('cloud-data-updated')); }
});
}

let browserClient, browserStorage, nativeClient, nativeStorage;
function currentClient() {
  if (Capacitor.isNativePlatform()) {
    if (!nativeClient || nativeStorage !== globalThis.localStorage) {
      nativeStorage = globalThis.localStorage;
      nativeClient = createNativeClient();
    }
    return nativeClient;
  }
  if (!browserClient || browserStorage !== globalThis.localStorage) {
    browserClient?.dispose();
    browserStorage = globalThis.localStorage;
    browserClient = createWebClient({ onData: () => window.dispatchEvent(new window.Event('cloud-data-updated')) });
  }
  return browserClient;
}
export const cloudClient = {
  getDb: () => Capacitor.isNativePlatform() ? localDb : currentClient().getDb()
};
for (const method of ['snapshot', 'subscribe', 'login', 'logout', 'restoreSession', 'sync', 'start', 'request',
  'getStoreProfile', 'loadStoreProfile', 'saveStoreProfile',
  'bootstrap', 'useCloudLedger', 'uploadRecoveredLedger', 'unlink', 'getVoiceConfig', 'getAliGenieDevices', 'getUsers',
  'saveVoiceConfig', 'previewVoice', 'synthesizeVoice', 'downloadAuthorization', 'recordConnection', 'retryPending', 'resolvePending']) {
  cloudClient[method] = (...args) => {
    const client = currentClient();
    return client[method].apply(client === nativeClient ? cloudClient : client, args);
  };
}

export async function copyToClipboard(text) {
  if (Capacitor.isNativePlatform()) return device.copyText({ text: String(text) });
  if (!navigator.clipboard?.writeText) throw new Error('复制失败，请使用支持复制功能的浏览器');
  await navigator.clipboard.writeText(String(text));
}

export function validateUpdate(manifest, serverUrl, currentVersion, appId = 'com.hairstudio.memberapp') {
  if (manifest.available === false) return null;
  const origin = normalizeServerUrl(serverUrl);
  const download = new URL(manifest.downloadPath, origin);
  if (manifest.appId !== appId || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode <= currentVersion ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.certificateSha256 || '') ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 250 * 1024 * 1024 ||
      download.origin !== origin || download.pathname !== '/api/v1/updates/files/' + manifest.sha256 + '.apk' || download.search || download.hash) throw new Error('更新清单不可信或版本不高于当前版本');
  return { ...manifest, url: download.href };
}
export async function checkForUpdate() {
  const current = Capacitor.isNativePlatform() ? await App.getInfo() : { build: '0', id: 'com.hairstudio.memberapp' };
  const manifest = await cloudClient.request('/updates/latest');
  if (manifest.available === false || manifest.versionCode <= Number(current.build)) return null;
  return validateUpdate(manifest, cloudClient.snapshot().serverUrl, Number(current.build), current.id);
}
export async function downloadUpdate(manifest, onProgress = () => {}) {
  const serverUrl = cloudClient.snapshot().serverUrl;
  const current = Capacitor.isNativePlatform() ? await App.getInfo() : { build: '0', id: 'com.hairstudio.memberapp' };
  manifest = validateUpdate(manifest, serverUrl, Number(current.build), current.id);
  const accessToken = await cloudClient.downloadAuthorization();
  if (Capacitor.isNativePlatform()) {
    const listener = await device.addListener('downloadProgress', event => onProgress(event.progress));
    try { return await device.downloadUpdate({ ...manifest, serverOrigin: serverUrl, accessToken }); }
    finally { await listener.remove(); }
  }
  const response = await fetch(manifest.url, { headers: { Authorization: 'Bearer ' + accessToken }, redirect: 'error', credentials: 'omit' });
  if (!response.ok) throw new Error('更新下载失败，请重新登录后重试');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== manifest.size || await sha256(bytes) !== manifest.sha256) throw new Error('安装包完整性校验失败，请重新下载');
  // APK 是二进制，浏览器通过 Blob 下载；系统安装器负责最终签名校验。
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.android.package-archive' }));
  const link = document.createElement('a'); link.href = url; link.download = 'member-manager-' + manifest.versionName + '.apk';
  document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  onProgress(100); return { browser: true, verified: true };
}
export async function installUpdate(file, manifest) {
  if (!Capacitor.isNativePlatform()) return { status: 'browser-download' };
  return device.installUpdate({ fileName: file.fileName, sha256: manifest.sha256, versionCode: manifest.versionCode });
}
