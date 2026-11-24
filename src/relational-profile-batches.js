import { parseUploadedFile } from '../admin/src/utils/importer.js';
import { COMMAND_ID, ENTITY_ID, memberInput, versionOf } from './relational-contract.js';
import { batchRequest } from './relational-batches.js';
import { canonicalJSON } from './canonical-json.js';
import { normalizeMemberName } from './member-identity.js';

const columns = Object.freeze({ name: ['name', '姓名', '会员姓名'], phone: ['phone', '电话', '手机号'], notes: ['notes', '备注'], tags: ['tags', '标签'],
  id: ['id', '会员编号', '会员单号'], version: ['version', '档案版本'] });
export function profileBatchRows(headers, rows, rowNumbers = []) {
  if (!rows.length || rows.length > 500) throw new Error('资料文件须包含 1–500 行');
  const map = {}, seen = new Set();
  for (const [index, raw] of headers.entries()) {
    const header = String(raw ?? '').trim().toLowerCase();
    if (!header && !rows.some(row => String(row[index] ?? '').trim())) continue;
    const key = Object.keys(columns).find(column => columns[column].includes(header));
    if (!key || map[key] !== undefined) throw new Error('表头含未知或重复字段。请仅保留姓名、电话、备注、标签、会员编号、档案版本；资金不在资料批次内导入。');
    map[key] = index;
  }
  if (map.name === undefined || (map.id === undefined) !== (map.version === undefined)) throw new Error('须有姓名表头。编辑需要同时提供会员编号和档案版本。');
  return rows.map((row, index) => {
    try {
      if (row.some((value, column) => column >= headers.length && String(value ?? '').trim())) throw new Error('表头之外有额外数据');
      const text = name => String(row[map[name]] ?? '').trim(), memberId = text('id'), version = text('version');
      if (memberId || version) {
        if (!ENTITY_ID.test(memberId) || seen.has(memberId)) throw new Error('会员编号无效或重复');
        versionOf(version, '原档案版本'); seen.add(memberId);
      }
      const data = memberInput({ name: text('name'), phone: text('phone'), notes: text('notes'), tags: text('tags').split('|').map(tag => tag.trim()).filter(Boolean),
        ...(memberId ? { expectedVersion: version } : {}) }, { update: Boolean(memberId) });
      return { type: memberId ? 'member.update' : 'member.create', ...(memberId ? { memberId } : {}), data: { ...data, ...(memberId ? { expectedVersion: version } : {}) } };
    } catch (cause) { throw new Error('资料第 ' + (rowNumbers[index] ?? index + 1) + ' 行：' + cause.message); }
  });
}

export async function readProfileBatch(file, { signal } = {}) {
  if (!file?.size || file.size > 2 * 1024 * 1024) throw new Error('资料表格须小于 2 MiB');
  const raw = await parseUploadedFile(file, { signal });
  const header = raw.slice(0, 5).findIndex(row => row.some(value => columns.name.includes(String(value ?? '').trim().toLowerCase())));
  if (header < 0) throw new Error('请在前 5 行设置姓名表头');
  const dataRows = [], rowNumbers = [];
  for (let index = header + 1; index < raw.length; index++) {
    if (!raw[index].some(value => String(value ?? '').trim())) continue;
    dataRows.push(raw[index]);
    rowNumbers.push(index + 1);
  }
  const rows = profileBatchRows(raw[header], dataRows, rowNumbers), bytes = new TextEncoder().encode(canonicalJSON(rows));
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  return { rows, digest, rowNumbers };
}

export async function reviewBatchNames(preview, read) {
  const counts = new Map(), names = new Set();
  for (const row of preview.rows) {
    const key = normalizeMemberName(row.data.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!row.data.phone) names.add(row.data.name);
  }
  if (!names.size) return { positions: [], signature: '' };
  const matches = await read('findActiveNames', { names: [...names] });
  const byName = new Map(), warnings = [];
  for (const match of matches) {
    if (!byName.has(match.nameKey)) byName.set(match.nameKey, []);
    byName.get(match.nameKey).push(match);
  }
  preview.rows.forEach((row, index) => {
    if (row.data.phone) return;
    const key = normalizeMemberName(row.data.name), peers = (byName.get(key) ?? []).filter(match => match.id !== row.memberId);
    if (peers.length || counts.get(key) > 1) warnings.push({ index, peers: peers.map(({ id, version }) => [id, version]).sort() });
  });
  return { positions: warnings.map(row => preview.rowNumbers[row.index]), signature: canonicalJSON(warnings) };
}

// Only capture metadata survives a close. After an uncertain capture, retry
// requires the original normalized file and regenerates the same row IDs.
export function batchIntake(workspace) {
  const same = scope => { if (!scope || canonicalJSON(scope) !== canonicalJSON(workspace.getScope())) throw new Error('原批次账号或账本代际已变化'); };
  const key = ({ storeId, actorId, deviceId }) => 'hairstudio_v2_batch:' + [storeId, actorId, deviceId].join(':');
  function pending(scope = workspace.getScope()) {
    if (!scope || !workspace.storage) return null;
    const raw = workspace.storage.getItem(key(scope)); if (raw === null) return null;
    const row = JSON.parse(raw);
    if (!COMMAND_ID.test(row?.id || '') || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || !Number.isInteger(row.count) || row.count < 1 || row.count > 500) throw new Error('原批次捕获信息无效，请保留记录核对');
    return row;
  }
  return { pending, async capture(preview, scope) {
    same(scope);
    const storageKey = key(scope);
    return workspace.lock(storageKey, async () => {
      same(scope);
      const prior = pending(scope), saved = prior ?? { id: crypto.randomUUID(), digest: preview.digest, ledgerEpoch: scope.ledgerEpoch, count: preview.rows.length };
      if (saved.ledgerEpoch !== scope.ledgerEpoch || saved.digest !== preview.digest || saved.count !== preview.rows.length) throw new Error('请重选原批次表格，不能更换账本代际、内容或批次号');
      const request = batchRequest({ ...scope, id: saved.id, sourceDigest: saved.digest, items: preview.rows.map((row, i) => ({ ...row, id: 'row-' + saved.id + '-' + i })) });
      const raw = JSON.stringify(saved); workspace.storage.setItem(storageKey, raw);
      if (workspace.storage.getItem(storageKey) !== raw) throw new Error('未可靠保存原批次号，尚未提交');
      const result = await workspace.batch.captureBatch(request);
      same(scope);
      if (result?.batchId !== saved.id || result.ledgerEpoch !== saved.ledgerEpoch || result.itemCount !== saved.count) throw new Error('批次回执与原捕获不一致');
      workspace.storage.removeItem(storageKey);
      return result;
    });
  } };
}
