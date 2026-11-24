import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { babelParse, parse } from '@vue/compiler-sfc';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries = {
  cashier: ['src/main.js'],
  merchant: ['admin/src/main.js'],
  platform: ['admin/src/platform-main.js'],
  api: ['server/main.js', 'server/migrate.js', 'server/create-owner.js', 'server/create-platform-admin.js', 'server/publish-release.js', 'server/prepare-recovery-target.js']
};
const domainFiles = ['src/ledger-domain.js', 'src/relational-contract.js', 'src/relational-opening-contract.js', 'src/relational-sales.js', 'src/relational-tasks.js'];
const findings = [], graph = new Map();
const report = (gate, file, reason, line) => findings.push({ gate, file, ...(line && { line }), reason });
const source = file => readFile(join(root, file), 'utf8');

function moduleReferences(code, file, offset = 0) {
  const refs = [];
  const ast = babelParse(code, { sourceType: 'module', createImportExpressions: true });
  const add = node => {
    if (node?.type === 'StringLiteral') refs.push({ specifier: node.value, line: node.loc.start.line + offset });
    else report('ARC-01', file, '无法静态确定模块引用', (node?.loc.start.line ?? 1) + offset);
  };
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      if (node.source) add(node.source);
    } else if (node.type === 'ImportExpression') add(node.source);
    else if (node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.name === 'require')) add(node.arguments[0]);
    else if (node.type === 'NewExpression' && node.callee.name === 'URL' && node.arguments[1]?.object?.type === 'MetaProperty') {
      const path = node.arguments[0]?.value;
      if (typeof path === 'string' && /\.(?:[cm]?js|sql)$/.test(path)) add(node.arguments[0]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'comments' || key.endsWith('Comments') || key === 'tokens') continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value?.type) walk(value);
    }
  }
  walk(ast.program);
  return refs;
}

async function discover(file) {
  if (graph.has(file)) return;
  const node = { imports: [] }; graph.set(file, node);
  let contents;
  try { contents = await source(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; report('ARC-01', file, '运行入口的本地依赖不存在'); return; }
  if (/\.(?:[cm]?js|vue)$/.test(file)) {
    let refs;
    if (file.endsWith('.vue')) {
      const { descriptor, errors } = parse(contents, { filename: file });
      if (errors.length) throw new Error(file + ': ' + errors.join(', '));
      const scripts = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
      refs = scripts.flatMap(block => block.src ? [{ specifier: block.src, line: block.loc.start.line }] : moduleReferences(block.content, file, block.loc.start.line - 1));
    } else refs = moduleReferences(contents, file);
    for (const { specifier, line } of refs) {
      const local = specifier.startsWith('.');
      const target = local ? posix.normalize(posix.join(posix.dirname(file), specifier)) : specifier;
      node.imports.push({ file: target, local, line });
      if (local) await discover(target);
    }
  }
  const retired = [
    [/\b(?:replayOperation|createLocalDb|validateSnapshot|ledger_protocol|installCloudRecording)\b/, '仍加载旧账本或旧协议代码'],
    [/\/api\/v1\/(?:account|sync|import)(?:\/|['"\x60?])/, '仍注册或发送旧账本路由'],
    [/\baccounts\.data\b|\b(?:FROM|UPDATE|INTO)\s+accounts\b|CREATE TABLE (?:IF NOT EXISTS )?(?:accounts|operations)\b/i, '仍读写旧整店账本'],
    [/hairstudio_(?:members|ledgers|cloud_state|cloud_pre_replace)_v\d+/, '仍访问旧本地账本或账务同步状态']
  ];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    for (const [pattern, reason] of retired) if (pattern.test(line)) report('ARC-03', file, reason, index + 1);
  }
}

function dependencies(roots) {
  const seen = new Set(), stack = new Set();
  function visit(file) {
    if (stack.has(file)) { report('ARC-01', file, '模块循环依赖: ' + [...stack, file].join(' → ')); return; }
    if (seen.has(file)) return;
    seen.add(file); stack.add(file);
    for (const next of graph.get(file).imports) if (next.local) visit(next.file);
    stack.delete(file);
  }
  roots.forEach(visit);
  return [...seen].sort();
}

for (const file of [...Object.values(entries).flat(), ...domainFiles]) await discover(file);
const reachable = Object.fromEntries(Object.entries(entries).map(([name, roots]) => [name, dependencies(roots)]));
const domain = dependencies(domainFiles);
for (const file of domain) {
  const forbidden = graph.get(file).imports.find(link => !link.local || !link.file.startsWith('src/') || /(?:\.vue|sqlite|android|remote|workspace)/i.test(link.file));
  if (forbidden) report('ARC-01', file, '领域层引用了运行环境: ' + forbidden.file, forbidden.line);
  if (/\b(?:window|document|localStorage|navigator|fetch)\s*[.(]/.test(await source(file))) report('ARC-01', file, '领域层直接访问运行环境');
}

const dockerfile = await source('Dockerfile');
const apiStage = dockerfile.split(/^FROM\s+/m).find(stage => /^[^\n]+ AS api\r?\n/i.test(stage)) ?? '';
const copied = new Set(apiStage.split(/\r?\n/).filter(line => /^COPY src\//.test(line)).flatMap(line => line.split(/\s+/).slice(1, -1)));
for (const file of reachable.api.filter(path => path.startsWith('src/'))) {
  if (/sqlite|android|workspace|\.vue$/.test(file)) report('ARC-01', file, '服务端依赖了客户端存储或界面');
  if (!copied.has(file)) report('ARC-07', 'Dockerfile', 'API 镜像缺少运行依赖: ' + file);
}
for (const file of copied) {
  if (!reachable.api.includes(file)) report('ARC-07', 'Dockerfile', 'API 镜像携带未被使用的客户端源码: ' + file);
}
const compose = await source('compose.yaml');
if (/^  (?:db|postgres):\s*$|\/var\/lib\/postgresql\/data|\bimage:\s*postgres[:@]/m.test(compose)) report('ARC-07', 'compose.yaml', '默认部署仍随 API 主机运行或挂载业务数据库');
if (!compose.includes('${MIGRATION_DATABASE_URL:') || !compose.includes('${DATABASE_URL:')) report('ARC-07', 'compose.yaml', '缺少独立 PostgreSQL 的迁移与运行连接配置');

const evidence = { checkedAt: new Date().toISOString(), scope: '运行入口导入图、领域边界、旧路由和存储扫描、API 镜像依赖与默认部署配置',
  releaseDecision: 'blocked pending remaining acceptance gates', entries, reachable, domain,
  edges: Object.fromEntries([...graph].sort(([a], [b]) => a.localeCompare(b)).map(([file, node]) => [file, node.imports])), findings };
await mkdir(join(root, 'output/refactor-v2'), { recursive: true });
await writeFile(join(root, 'output/refactor-v2/architecture-audit.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ modules: graph.size, findings, report: 'output/refactor-v2/architecture-audit.json' }, null, 2));
process.exitCode = findings.length ? 1 : 0;
