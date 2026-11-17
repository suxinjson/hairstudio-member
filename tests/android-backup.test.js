import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Android backups exclude WebView local storage from cloud backup and device transfer', async () => {
  const manifest = await readFile(new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  const backupRules = await readFile(new URL('../android/app/src/main/res/xml/backup_rules.xml', import.meta.url), 'utf8');
  const extractionRules = await readFile(new URL('../android/app/src/main/res/xml/data_extraction_rules.xml', import.meta.url), 'utf8');
  const webViewExclusion = /<exclude\s+domain="root"\s+path="app_webview"\s*\/>/;

  assert.match(manifest, /android:fullBackupContent="@xml\/backup_rules"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  assert.match(backupRules, webViewExclusion);
  assert.match(backupRules, /<exclude\s+domain="sharedpref"\s+path="member_cloud_vault.xml"\s*\/>/);
  for (const domain of ['cloud-backup', 'device-transfer']) {
    const block = extractionRules.match(new RegExp(`<${domain}>([\\s\\S]*?)</${domain}>`))?.[1];
    assert.ok(block, `${domain} rule is present`);
    assert.match(block, webViewExclusion);
    assert.match(block, /<exclude\s+domain="sharedpref"\s+path="member_cloud_vault.xml"\s*\/>/);
  }
});
