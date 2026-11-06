import { boundedText, DATA_LIMITS } from './data-limits.js';

// Legacy backups use either one text label or an array. Keep their representation
// intact so restoring a label does not change financial sync preconditions.
export function validateMemberTags(member) {
  if (member.tags != null) {
    const tags = typeof member.tags === 'string' ? [member.tags] : member.tags;
    if (!Array.isArray(tags) || tags.length > 32) throw new Error('会员标签须为文本或最多 32 个文本标签');
    for (const tag of tags) boundedText(tag, DATA_LIMITS.name, '会员标签');
  }
  if (member.tag != null) boundedText(member.tag, DATA_LIMITS.name, '会员标签');
}

export function memberTagText(member) {
  const tags = typeof member.tags === 'string' ? member.tags : Array.isArray(member.tags)
    ? member.tags.filter(tag => typeof tag === 'string').join('、') : '';
  return tags.trim() || (typeof member.tag === 'string' ? member.tag.trim() : '') ||
    /^\[([^\]]+)\]/.exec(typeof member.notes === 'string' ? member.notes : '')?.[1] || '';
}
