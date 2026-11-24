import { displayCents } from './relational-presentation.js';

export const LEDGER_EXPORT = Object.freeze({ days: 366, rows: 25000, bytes: 8 * 1024 * 1024, slots: 8, minutes: 15, timeoutMs: 90000 });
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const LEDGER_SHEET = '财务流水';
export const LEDGER_COLUMNS = Object.freeze(['流水编号', '会员编号', '姓名', '发生时间(UTC)', '类型', '变动金额(元)', '变动前(元)', '变动后(元)', '实收(元)', '赠送(元)', '项目', '支付', '对应原单号', '对应冲正号', '备注']);
const kind = { recharge: '充值', consume: '消费', reversal: '冲正', adjustment: '调整' };

export function ledgerSheetRow(row) {
  return [row.id, row.memberId, row.memberName, row.occurredAt, kind[row.type], displayCents(row.deltaCents), displayCents(row.balanceBeforeCents),
    displayCents(row.balanceAfterCents), displayCents(row.actualPayCents), displayCents(row.giftCents),
    row.items?.map(item => item.name + ' × ' + item.quantity + ' ¥' + displayCents(item.lineTotalCents)).join('；') || row.itemsSummary,
    row.payments?.map(pay => pay.method + ' ¥' + displayCents(pay.amountCents)).join('；') || row.payMethod,
    row.originalEntryId, row.reversalEntryId, row.remark].map(value => value == null ? '' : String(value));
}

export function relationalExportBook(XLSX, { name, rows }) {
  // These values must remain text: formulas are not evaluated, identifiers
  // keep leading zeros, and no exact cents become JS/Excel floating point.
  const sheet = XLSX.utils.aoa_to_sheet(rows, { dense: true });
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, name); return book;
}
