import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function refactorSources(root) {
  async function scan(directory) {
    const files = [];
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory() && !['node_modules', 'dist', 'build', '.gradle', 'output', 'tmp'].includes(entry.name) && path !== 'android/app/src/main/assets') files.push(...await scan(path));
      else if (entry.isFile() && /\.(?:[cm]?js|vue|sql|java|json|xml|gradle|ya?ml|css|html|sh|properties|png)$/.test(entry.name)) files.push(path);
    }
    return files;
  }
  const files = [...new Set([...(await scan('src')), ...(await scan('admin/src')), ...(await scan('server')), ...(await scan('tests')), ...(await scan('tools')), ...(await scan('scripts')), ...(await scan('android/app/src')), ...(await scan('deploy')),
    '.env.example', '.dockerignore', 'Dockerfile', 'package.json', 'package-lock.json', 'compose.yaml', '.github/workflows/build-apk.yml', 'capacitor.config.json',
    'index.html', 'vite.config.js', 'admin/index.html', 'admin/platform.html', 'admin/package.json', 'admin/vite.config.js', 'deploy/Caddyfile', 'deploy/Caddyfile.ip',
    'android/app/build.gradle', 'android/app/capacitor.build.gradle', 'android/app/proguard-rules.pro', 'android/build.gradle', 'android/capacitor.settings.gradle',
    'android/settings.gradle', 'android/variables.gradle', 'android/gradle.properties', 'android/gradlew', 'android/gradlew.bat',
    'android/gradle/wrapper/gradle-wrapper.jar', 'android/gradle/wrapper/gradle-wrapper.properties', 'vendor/xlsx-0.20.3.tgz'])].sort();
  const hash = createHash('sha256'), manifest = [];
  for (const file of files) { const bytes = await readFile(join(root, file)); hash.update(file + '\0'); hash.update(bytes); hash.update('\0'); manifest.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  return { digest: hash.digest('hex'), count: files.length, manifest };
}
