import { displayCents } from './relational-presentation.js';

export const NOTICE_TYPES = [
  { value: 'notice', label: '通知' },
  { value: 'reminder', label: '提醒' },
  { value: 'warning', label: '注意' }
];
export const noticeTypeLabel = type => NOTICE_TYPES.find(item => item.value === type)?.label || '通知';

// A debt can clear and recur between snapshots with the same member and amount.
// Financial history distinguishes these incidents without reacting to edits.
export function debtNoticeVersion(members, ledgers = []) {
  const debtMembers = members.filter(member => !member.isArchived && member.balance < 0);
  const entries = new Map(debtMembers.map(member => [member.id, 0]));
  for (const ledger of ledgers) {
    if (entries.has(ledger.memberId)) entries.set(ledger.memberId, entries.get(ledger.memberId) + 1);
  }
  return JSON.stringify(debtMembers.map(member => [member.id, member.balance, entries.get(member.id)])
    .sort(([a], [b]) => a.localeCompare(b)));
}

export function systemNotices({ dashboard = {}, relationalBalances, debtVersion = '', state = {}, storageError = '', isWeb = false, availableUpdate = null }) {
  const notices = [];
  const add = (id, type, title, body, version, action, actionLabel, required = false) => notices.push({
    id: 'system:' + id, source: 'system', type, title, body, version, action, actionLabel,
    buttonLabel: required ? '' : '我知道了', allowDelete: !required, showInHeader: true, required
  });
  if (storageError) add('storage', 'warning', '账本需要恢复',
    '当前账本无法读取：' + storageError + '。请从有效备份恢复，恢复前会保留原始数据。', storageError, 'backup-files', '打开备份恢复', true);
  if (state.bindingRecovery) add('recovery', 'warning', '请核对并加载云端账本',
    '登录已恢复，请先核对并加载云端账本 · 暂停记账。', 'recovery', 'account', '前往核对', true);
  else if (state.status === 'conflict' || isWeb && (state.error || state.pending)) add('connection', 'warning', '账本需要核对',
    (state.error || (state.pending ? '上一笔操作的服务器结果尚未确认' : '本机与云端账本存在冲突，请核对后继续')) + ' · 暂停记账。',
    state.error || state.status + ':' + Boolean(state.pending), 'account', '查看并处理', true);
  else if (state.binding && state.binding.mode !== 'standalone' && (state.pendingCount || state.outbox?.length || !state.online || state.syncLoginRequired || state.syncStatus === 'error')) {
    const pending = state.pendingCount ?? state.outbox?.length ?? 0;
    add('sync', 'reminder', state.syncLoginRequired ? '请重新登录同步' : pending ? pending + ' 笔记录待同步' : '连接需要留意',
      state.syncLoginRequired ? '登录已失效，请重新登录。本机账本与待同步记录仍保留。'
        : (state.online ? '请打开同步设置检查连接。' : '当前离线，联网后会继续同步。') + (pending ? '待同步 ' + pending + ' 笔，本机记录已保留。' : ''),
      // A retry can change both transport and sync status without changing the
      // incident. Keep its receipt until the pending count or login need changes.
      [pending, Boolean(state.syncLoginRequired)].join(':'), 'account', '同步设置');
  }
  if (!storageError && (relationalBalances?.debtCount > 0 || dashboard.totalDebt > 0)) {
    const count = relationalBalances?.debtCount ?? dashboard.debtMemberCount;
    const amount = relationalBalances ? displayCents(relationalBalances.debtCents.replace(/^-/, '')) : (dashboard.totalDebt / 100).toFixed(2);
    add('debt', 'reminder', count + ' 位会员尚有欠款', '待收回 ¥' + amount + '，可查看欠款会员并办理充值或还款。', debtVersion, 'debt', '查看欠款会员');
  }
  if (availableUpdate && !isWeb) add('update', 'notice', '发现新版本 ' + availableUpdate.versionName,
    (availableUpdate.notes ? availableUpdate.notes + '\n\n' : '') + '可在应用更新页面下载并安装，现有账本会保留。',
    String(availableUpdate.versionCode), 'update', '前往更新');
  return notices;
}
