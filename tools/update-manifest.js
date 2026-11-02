import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import config from '../capacitor.config.json' with { type: 'json' };

export function buildUpdateManifest(bytes, { versionCode, versionName, certificateSha256, notes = '' }) {
  certificateSha256 = String(certificateSha256).replace(/[:\s]/g, '').toLowerCase();
  if (!Number.isSafeInteger(versionCode) || versionCode < 1 || typeof versionName !== 'string' ||
    !versionName || !/^[a-f0-9]{64}$/.test(certificateSha256) || !bytes.length) throw new Error('版本号、签名指纹或安装包无效');
  return { appId: config.appId, versionCode, versionName, certificateSha256,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, minSdk: 24, notes };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [apkPath, outputPath] = process.argv.slice(2);
  if (!apkPath || !outputPath || !process.env.APKSIGNER) throw new Error('须提供 APK、清单路径和 APKSIGNER 环境变量');
  const verification = execFileSync(process.env.APKSIGNER, ['verify', '--print-certs', apkPath], { encoding: 'utf8' });
  const actual = /Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9]+)/.exec(verification)?.[1]?.toLowerCase();
  const expected = String(process.env.RELEASE_CERT_SHA256 || '').replace(/[:\s]/g, '').toLowerCase();
  if (!actual || actual !== expected) throw new Error('APK 实际签名与固定证书不一致');
  const manifest = buildUpdateManifest(await readFile(apkPath), { versionCode: Number(process.env.VERSION_CODE),
    versionName: process.env.VERSION_NAME, certificateSha256: actual, notes: process.env.RELEASE_NOTES || '' });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + '\n');
}
