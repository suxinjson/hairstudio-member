// Keep distinguishing suffixes such as “张姐（东区）” when comparing names.
export function normalizeMemberName(name) {
  return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export const MEMBER_IDENTITY_ADVICE = '建议填写手机号，或在备注中补充便于辨识的信息，也可以在姓名后加括号备注，例如“张姐（东区）”。';

export function sameNameMembers(members, member) {
  const name = normalizeMemberName(member.name);
  if (!name || String(member.phone || '').trim()) return [];
  return members.filter(other => !other.isArchived && (!member.id || other.id !== member.id) &&
    normalizeMemberName(other.name) === name);
}

export function memberIdentitySignature(members) {
  return JSON.stringify(members.map(member => [member.id, member.name, member.phone || '', member.notes || ''])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

export function sameNameMemberPrompt(member, matches) {
  const examples = matches.slice(0, 3).map(other => {
    const phone = other.phone ? '手机尾号 ' + String(other.phone).slice(-4) : '未留手机号';
    const notes = other.notes ? '，备注：' + String(other.notes).slice(0, 60) : '';
    return `• ${other.name}（${phone}${notes}）`;
  }).join('\n');
  return {
    title: '发现同名会员',
    message: `当前已有 ${matches.length} 位与「${member.name.trim()}」同名的会员，本次未填写手机号，容易混淆档案。\n${examples}\n\n${MEMBER_IDENTITY_ADVICE}\n请先核对已有档案；确认是不同会员后，也可选择仍然保存。`,
    confirmText: '仍然保存', cancelText: '返回补充'
  };
}
