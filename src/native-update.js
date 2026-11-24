import { App } from '@capacitor/app';
import { normalizeServerUrl } from './server-origin.js';
import { cloudDeviceBridge } from './relational-native-session.js';

export function validateUpdate(manifest, serverUrl, currentVersion, appId = 'com.hairstudio.memberapp') {
  if (manifest.available === false) return null;
  const origin = normalizeServerUrl(serverUrl), download = new URL(manifest.downloadPath, origin);
  if (manifest.channel !== 'relational-v2' || manifest.appId !== appId || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode <= currentVersion ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !/^[a-f0-9]{64}$/.test(manifest.certificateSha256 || '') ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 250 * 1024 * 1024 ||
      download.origin !== origin || download.username || download.password || download.pathname !== '/api/v1/updates/files/' + manifest.sha256 + '.apk' ||
      download.search || download.hash) throw new Error('更新清单不可信或版本不高于当前版本');
  return { ...manifest, url: download.href };
}

export function createNativeUpdate(session, { device = cloudDeviceBridge, app = App } = {}) {
  const state = session.state;
  function capture() {
    const { generation, serverUrl, user } = state;
    if (!user || state.binding?.mode !== 'cloud' || !state.online || !state.deviceAccess.allowed) throw new Error('请联网登录后更新');
    return { serverUrl, assert() { if (generation !== state.generation || serverUrl !== state.serverUrl) throw new Error('账号或服务器已变化，请重新检查更新'); } };
  }
  return {
    async check() {
      const context = capture(), current = await app.getInfo(); context.assert();
      const manifest = await session.request('/api/v1/updates/latest?channel=relational-v2'); context.assert();
      if (manifest.available === false || manifest.versionCode <= Number(current.build)) return null;
      return validateUpdate(manifest, context.serverUrl, Number(current.build), current.id);
    },
    async download(manifest, onProgress) {
      const context = capture(), current = await app.getInfo(); context.assert();
      const version = validateUpdate(manifest, context.serverUrl, Number(current.build), current.id);
      if (!version) throw new Error('没有可下载的更新');
      const accessToken = await session.downloadAuthorization(); context.assert();
      const listener = await device.addListener('downloadProgress', event => onProgress(event.progress));
      try {
        context.assert();
        const file = await device.downloadUpdate({ ...version, serverOrigin: context.serverUrl, accessToken });
        context.assert();
        if (!file?.verified || file.fileName !== version.sha256 + '.apk') throw new Error('安装包校验未确认');
        return file;
      } finally { await listener.remove(); }
    },
    install: (file, manifest) => device.installUpdate({ fileName: file.fileName, sha256: manifest.sha256, versionCode: manifest.versionCode }),
    installedBuild: async () => Number((await app.getInfo()).build)
  };
}
