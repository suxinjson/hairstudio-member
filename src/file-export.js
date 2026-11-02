import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export function isExportCancelled(error) {
  return error?.name === 'AbortError' || /share cancel(?:ed|led)/i.test(error?.message || '');
}

export function createFileExporter({
  isNative = () => Capacitor.isNativePlatform(), filesystem = Filesystem, share = Share,
  browser = () => ({ navigator, document, URL }), defer = (callback) => setTimeout(callback, 1000)
} = {}) {
  return async function exportFile({ content, fileName, mimeType, title }) {
    const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_');
    if (isNative()) {
      const path = `exports/${Date.now()}-${Math.random().toString(36).slice(2, 10)}_${safeName}`;
      await filesystem.writeFile({ path, data: content, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      const { uri } = await filesystem.getUri({ path, directory: Directory.Cache });
      if (!uri) throw new Error('无法取得导出文件，请重新导出');
      await share.share({ title, files: [uri], dialogTitle: '发送文件或选择保存位置' });
      return { kind: 'shared', fileName: safeName };
    }
    const { navigator: webNavigator, document: webDocument, URL: webURL } = browser();
    const blob = new Blob([content], { type: mimeType });
    const file = new File([blob], safeName, { type: mimeType });
    if (webNavigator.share && webNavigator.canShare?.({ files: [file] })) {
      await webNavigator.share({ title, files: [file] });
      return { kind: 'shared', fileName: safeName };
    }
    const url = webURL.createObjectURL(blob);
    try {
      const link = webDocument.createElement('a');
      link.href = url;
      link.download = safeName;
      webDocument.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
    } finally {
      // 等待浏览器读取 Blob 后再释放，避免下载尚未开始时失效。
      defer(() => webURL.revokeObjectURL(url));
    }
    return { kind: 'download-requested', fileName: safeName };
  };
}

export const exportFile = createFileExporter();
