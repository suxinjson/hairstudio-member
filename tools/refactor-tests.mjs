import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { refactorSources } from './refactor-source.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url)), postgres = process.argv.includes('--postgres');
if (process.argv.slice(2).some(arg => arg !== '--postgres')) throw new Error('仅支持 --postgres 参数');
if (postgres && (!process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL || !process.env.MEMBER_TEST_ADMIN_DATABASE_URL || process.env.MEMBER_TEST_DATABASE_DISPOSABLE !== '1')) {
  console.error('未执行：真实 PostgreSQL 验收须设置专用测试库 MEMBER_RELATIONAL_TEST_DATABASE_URL、同一测试集群的 MEMBER_TEST_ADMIN_DATABASE_URL 和 MEMBER_TEST_DATABASE_DISPOSABLE=1。'); process.exit(2);
}
const files = ['server/tests/relational-cutover.test.js', 'server/tests/relational-ledger.test.js', 'server/tests/relational-sync.test.js', 'server/tests/relational-backup.test.js',
  'server/tests/relational-batches.test.js', 'server/tests/relational-voice.test.js', 'server/tests/relational-replica.test.js', 'server/tests/transaction.test.js',
  ...(!postgres ? ['tests/ledger-domain.test.js', 'tests/ledger-epoch.test.js', 'tests/relational-sales.test.js', 'tests/relational-reports.test.js', 'tests/relational-tasks.test.js', 'tests/relational-import.test.js', 'tests/relational-sqlite.test.js', 'tests/android-sqlite-driver.test.js', 'tests/android-archive-documents.test.js', 'tests/relational-backup-files.test.js', 'tests/relational-archive-files.test.js', 'tests/relational-batches.test.js', 'tests/relational-archive.test.js'] : ['server/tests/relational-postgres.acceptance.mjs', 'server/tests/relational-export.acceptance.mjs', 'server/tests/database-role.test.js'])];
const startedAt = new Date().toISOString(), runId = startedAt.replace(/[-:.]/g, '') + (postgres ? '-postgres' : '-local');
const directory = join(root, 'output/refactor-v2', runId); await mkdir(directory, { recursive: true });
const sources = await refactorSources(root);
await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(sources.manifest, null, 2) + '\n');
const log = createWriteStream(join(directory, 'tests.tap')), errorLog = createWriteStream(join(directory, 'stderr.log'));
let tail = '';
const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=tap', ...files], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => { log.write(chunk); tail = (tail + chunk.toString()).slice(-4000); }); child.stderr.pipe(errorLog);
const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => resolve(code ?? 1)); });
log.end(); await Promise.all([finished(log), finished(errorLog)]);
const metric = name => Number([...tail.matchAll(new RegExp('^# ' + name + ' (\\d+)$', 'gm'))].at(-1)?.[1] ?? 0);
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const sqlite = new DatabaseSync(':memory:'), sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS version').get().version; sqlite.close();
const sourceUnchangedDuringTests = (await refactorSources(root)).digest === sources.digest;
const tests = metric('tests'), passed = metric('pass'), failed = metric('fail'), cancelled = metric('cancelled'), skipped = metric('skipped');
const allPassed = sourceUnchangedDuringTests && exitCode === 0 && tests > 0 && passed === tests && !failed && !cancelled && !skipped;
const report = { runId, startedAt, finishedAt: new Date().toISOString(), gitCommit: git.status === 0 ? git.stdout.trim() : null,
  sourceDigest: sources.digest, sourceFileCount: sources.count, sourceUnchangedDuringTests, environment: { node: process.version, platform: platform(), arch: arch(),
    serverDatabase: process.env.MEMBER_RELATIONAL_TEST_DATABASE_URL ? 'dedicated PostgreSQL; see test log' : 'PGlite; serialized logic only', localDatabase: 'real file SQLite via node:sqlite', sqliteVersion, androidDevice: 'not exercised' },
  files, exitCode: allPassed ? 0 : exitCode || 1, tests, passed, failed, cancelled, skipped,
  evidenceScope: 'core automated tests only; not full refactor, performance or production cutover acceptance', releaseDecision: 'blocked' };
await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, artifacts: 'output/refactor-v2/' + runId }, null, 2)); process.exitCode = report.exitCode;
