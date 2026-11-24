import { canonicalJSON } from '../../../src/canonical-json.js';
import { byteLength } from '../../../src/data-limits.js';
import { displayCents } from '../../../src/relational-presentation.js';
import { versionOf } from '../../../src/relational-contract.js';

export { relationalExportBook } from '../../../src/relational-export-sheet.js';

export const EXPORT_ROWS = 5000;
const EXPORT_BYTES = 12 * 1024 * 1024;
const members = ['会员编号', '姓名', '手机号', '标签', '备注', '剩余可用余额(元)', '资料版本', '账户版本', '建档时间(UTC)', '归档时间(UTC)'];
const text = value => value == null ? '' : String(value);
const memberRow = row => [row.id, row.name, row.phone, (row.tags ?? []).join('；'), row.notes, displayCents(row.balanceCents), row.version, row.accountVersion, row.createdAt, row.archivedAt].map(text);

export async function collectMemberExport(workspace, { signal, progress = () => {} } = {}) {
  const scope = workspace.getScope(), identity = canonicalJSON(scope);
  const check = () => {
    if (signal?.aborted || !scope || canonicalJSON(workspace.getScope()) !== identity) throw new Error('导出已取消或登录身份已变化');
  };
  async function watermark() {
    check(); const head = await workspace.read('getExportWatermark'); check();
    if (head?.storeId !== scope.storeId || head.ledgerEpoch !== scope.ledgerEpoch) throw new Error('门店账本已变化，请重新导出');
    return versionOf(head.cursor, '导出水位');
  }
  const start = await watermark(), rows = [members], ids = new Set(); let size = 0;
  for (const balance of ['all', 'archived']) {
    let cursor;
    do {
      check(); const page = await workspace.read('listMembers', { balance, cursor, limit: 100 }); check();
      for (const row of page.items) {
        if (ids.has(row.id)) throw new Error('导出期间资料改变，请重新导出');
        ids.add(row.id);
        const cells = memberRow(row); size += byteLength(JSON.stringify(cells));
        if (ids.size > EXPORT_ROWS || size > EXPORT_BYTES) throw new Error('文件超出导出上限，请缩小范围或使用业务备份');
        rows.push(cells);
      }
      progress(ids.size);
      if (page.nextCursor && (!page.items.length || page.nextCursor === cursor)) throw new Error('导出分页未前进，请重试');
      cursor = page.nextCursor;
    } while (cursor);
  }
  if (await watermark() !== start) throw new Error('导出期间账本有变动，请稍后重试');
  check(); return { name: '会员档案', rows };
}
