import test from 'node:test';
import assert from 'node:assert/strict';
import { validateUpdate } from '../src/cloud-device.js';
import { normalizeServerUrl } from '../src/cloud-client.js';
const hash = 'a'.repeat(64);
const manifest = { versionCode: 2, versionName: '1.0.2', appId: 'com.hairstudio.memberapp', sha256: hash,
  certificateSha256: 'b'.repeat(64), size: 100, downloadPath: '/api/v1/updates/files/' + hash + '.apk' };
test('server configuration rejects cleartext internet URLs and credential-bearing URLs', () => {
  for (const value of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?token=secret', 'ftp://example.com']) assert.throws(() => normalizeServerUrl(value));
  assert.equal(normalizeServerUrl('https://member.example.com/'), 'https://member.example.com');
});
test('update manifests reject another origin, package, downgrade, invalid hash or excessive size', () => {
  assert.equal(validateUpdate(manifest, 'https://member.example.com', 1).url, 'https://member.example.com' + manifest.downloadPath);
  for (const patch of [{ downloadPath: 'https://attacker.example/update.apk' }, { appId: 'another.app' }, { versionCode: 1 },
    { versionCode: 2.1 }, { sha256: 'invalid' }, { certificateSha256: 'invalid' }, { size: 251 * 1024 * 1024 },
    { downloadPath: manifest.downloadPath + '?token=anything' }]) assert.throws(() => validateUpdate({ ...manifest, ...patch }, 'https://member.example.com', 1));
});
