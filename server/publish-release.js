import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createPool, transaction } from './database.js';
import { digest } from './security.js';
import capacitorConfig from '../capacitor.config.json' with { type: 'json' };

export async function publishRelease(pool, manifest, bytes, directory, expectedCertificate, { retentionCount = 5 } = {}) {
  const certificate = String(expectedCertificate || '').replace(/[:\s]/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(certificate) || manifest.certificateSha256 !== certificate ||
      manifest.appId !== capacitorConfig.appId || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1 ||
      typeof manifest.versionName !== 'string' || manifest.versionName.length > 64 ||
      digest(bytes) !== manifest.sha256 || bytes.length !== manifest.size) throw new Error('更新版本、文件校验或固定签名证书不匹配');
  const fileName = manifest.sha256 + '.apk';
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(739185)");
    const { rows: [latest] } = await client.query('SELECT * FROM releases ORDER BY version_code DESC LIMIT 1');
    const sameRelease = latest?.version_code === manifest.versionCode && latest.sha256 === manifest.sha256 &&
      latest.version_name === manifest.versionName && latest.app_id === manifest.appId && Number(latest.size) === manifest.size &&
      latest.certificate_sha256 === certificate && latest.min_sdk === (manifest.minSdk || 24) && latest.notes === (manifest.notes || '');
    if (latest && latest.version_code >= manifest.versionCode && !sameRelease) throw new Error('新版本号必须高于已发布版本，已有版本不能对应不同安装包或清单');
    await mkdir(directory, { recursive: true });
    const temporary = join(resolve(directory), randomUUID() + '.part');
    await writeFile(temporary, bytes);
    await rename(temporary, join(resolve(directory), fileName));
    if (sameRelease) return { versionCode: manifest.versionCode, fileName, unchanged: true };
    await client.query('INSERT INTO releases(version_code,version_name,app_id,sha256,size,file_name,certificate_sha256,min_sdk,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [manifest.versionCode, manifest.versionName, manifest.appId, manifest.sha256, manifest.size, fileName, certificate, manifest.minSdk || 24, manifest.notes || '']);
    if (retentionCount > 0) {
      const { rows: oldReleases } = await client.query('SELECT file_name FROM releases ORDER BY version_code DESC OFFSET $1', [retentionCount]);
      if (oldReleases.length) {
        await client.query('DELETE FROM releases WHERE file_name = ANY($1)', [oldReleases.map(r => r.file_name)]);
        for (const old of oldReleases) {
          try { await unlink(join(resolve(directory), old.file_name)); } catch {}
        }
      }
    }
    return { versionCode: manifest.versionCode, fileName };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool();
  try {
    const [manifestPath, apkPath] = process.argv.slice(2);
    if (!manifestPath || !apkPath) throw new Error('用法：npm run server:publish -- 更新清单.json 安装包.apk');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const bytes = await readFile(apkPath);
    console.log(await publishRelease(
      pool,
      manifest,
      bytes,
      process.env.RELEASE_DIRECTORY || './releases',
      process.env.RELEASE_CERT_SHA256,
      { retentionCount: Number(process.env.RELEASE_RETENTION_COUNT || 5) }
    ));
  } finally { await pool.end(); }
}
