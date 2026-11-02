import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { createPool, migrate, transaction } from './database.js';
import { digest } from './security.js';
import capacitorConfig from '../capacitor.config.json' with { type: 'json' };

export async function publishRelease(pool, manifest, bytes, directory, expectedCertificate) {
  const certificate = String(expectedCertificate || '').replace(/[:\s]/g, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(certificate) || manifest.certificateSha256 !== certificate ||
      manifest.appId !== capacitorConfig.appId || !Number.isSafeInteger(manifest.versionCode) || manifest.versionCode < 1 ||
      typeof manifest.versionName !== 'string' || manifest.versionName.length > 64 ||
      digest(bytes) !== manifest.sha256 || bytes.length !== manifest.size) throw new Error('更新版本、文件校验或固定签名证书不匹配');
  const fileName = manifest.sha256 + '.apk';
  await mkdir(directory, { recursive: true });
  const temporary = join(resolve(directory), randomUUID() + '.part');
  await writeFile(temporary, bytes);
  await rename(temporary, join(resolve(directory), fileName));
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(739185)");
    const { rows: [latest] } = await client.query('SELECT version_code FROM releases ORDER BY version_code DESC LIMIT 1');
    if (latest && latest.version_code >= manifest.versionCode) throw new Error('新版本号必须高于已发布版本');
    await client.query('INSERT INTO releases(version_code,version_name,app_id,sha256,size,file_name,certificate_sha256,min_sdk,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [manifest.versionCode, manifest.versionName, manifest.appId, manifest.sha256, manifest.size, fileName, certificate, manifest.minSdk || 24, manifest.notes || '']);
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
    await migrate(pool);
    console.log(await publishRelease(pool, manifest, bytes, process.env.RELEASE_DIRECTORY || './releases', process.env.RELEASE_CERT_SHA256));
  } finally { await pool.end(); }
}
