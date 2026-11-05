const financialFields = ['balance', 'total_recharge', 'total_consume'];

// Use the same identity for formatted numbers in every client and the server.
// Keep historical display text intact; only new/edited profiles store this value.
export const normalizeMemberPhone = phone => phone.trim().replace(/\D/g, '');

function indexLedgers(records) {
  const byId = new Map(), byMember = new Map();
  for (const record of records) {
    byId.set(record.id, record);
    if (!byMember.has(record.memberId)) byMember.set(record.memberId, []);
    byMember.get(record.memberId).push(record);
  }
  return { byId, byMember };
}

export function validateActiveMemberPhones(members) {
  const phones = new Set();
  for (const member of members) {
    if (member.isArchived) continue;
    const phone = normalizeMemberPhone(member.phone);
    if (!phone || phones.has(phone)) {
      throw new Error('账本包含空手机号或重复的在用会员手机号，请按会员单号核对并修改档案后再记账');
    }
    phones.add(phone);
  }
}

export function normalizeRefunds(records) {
  const ledgers = records.map(record => ({ ...record }));
  const byId = new Map(ledgers.map(record => [record.id, record]));
  const refundedIds = new Set();
  for (const refund of ledgers.filter(record => record.type === 'REFUND')) {
    // 兼容旧版将原单号写在备注中的冲正记录。
    const originalId = refund.originalLedgerId || /原单号:([^\s()]+)/.exec(refund.remark || '')?.[1];
    const original = byId.get(originalId);
    if (!original || !['RECHARGE', 'CONSUME'].includes(original.type) ||
        original.memberId !== refund.memberId || refund.changeAmount !== -original.changeAmount ||
        refundedIds.has(originalId)) {
      throw new Error('冲正流水与原单关联异常或存在重复撤销，请核对账本后恢复');
    }
    refund.originalLedgerId = originalId;
    original.isRefunded = true;
    refundedIds.add(originalId);
  }
  if (ledgers.some(record => record.isRefunded && !refundedIds.has(record.id))) {
    throw new Error('已撤销标记缺少对应冲正流水，请核对账本后恢复');
  }
  return ledgers;
}

export function restoreArchivedMembers(members, ledgers) {
  const restored = members.map(member => ({ ...member }));
  const ids = new Set(restored.map(member => member.id));
  const { byId, byMember } = indexLedgers(ledgers);
  for (const [id, history] of byMember) {
    if (ids.has(id)) continue;
    const totals = ledgerEffects(history, byId);
    const latest = history[0];
    if (!id || latest.balanceAfter !== 0 || totals.balance !== 0 ||
        totals.total_recharge < 0 || totals.total_consume < 0) {
      throw new Error('存在缺失会员档案且无法确认余额的流水，请核对账本后恢复');
    }
    restored.push({
      id, name: latest.memberName || '已注销会员', phone: latest.memberPhone || '',
      balance: 0, total_recharge: totals.total_recharge, total_consume: totals.total_consume,
      notes: '', isArchived: true, deleted_at: latest.created_at,
      created_at: history.at(-1).created_at, updated_at: latest.created_at
    });
  }
  return restored;
}

function ledgerEffects(records, byId) {
  const result = { balance: 0, total_recharge: 0, total_consume: 0 };
  for (const record of records) {
    result.balance += record.changeAmount;
    if (record.type === 'RECHARGE') result.total_recharge += record.changeAmount;
    if (record.type === 'CONSUME') result.total_consume -= record.changeAmount;
    if (record.type === 'REFUND') {
      const original = byId.get(record.originalLedgerId);
      if (!original) throw new Error('冲正流水缺少原单');
      if (original.type === 'RECHARGE') result.total_recharge += record.changeAmount;
      else result.total_consume -= record.changeAmount;
    }
  }
  return result;
}

export function validateAccountHistory(members, ledgers) {
  const { byId, byMember } = indexLedgers(ledgers);
  for (const member of members) {
    // 流水按写入顺序存储；手机时间回拨也不能改变资金变动顺序。
    const history = byMember.get(member.id) || [];
    if (!history.length) continue; // 兼容旧版只有期初余额、尚无流水的档案。
    const effects = ledgerEffects(history, byId);
    const openingRecharge = member.total_recharge - effects.total_recharge;
    const openingConsume = member.total_consume - effects.total_consume;
    if (member.balance !== history[0].balanceAfter || openingRecharge < 0 || openingConsume < 0 ||
        openingRecharge - openingConsume !== history.at(-1).balanceBefore ||
        history.some((record, index) => index + 1 < history.length && record.balanceBefore !== history[index + 1].balanceAfter)) {
      throw new Error(`会员「${member.name}」的余额与流水不一致，请核对账本后恢复`);
    }
  }
}

function assertExtension(earlier, later, additions, byId) {
  const delta = ledgerEffects(additions, byId);
  if (financialFields.some(field => !Number.isSafeInteger(earlier[field] + delta[field]) ||
      earlier[field] + delta[field] !== later[field])) {
    throw new Error(`会员「${earlier.name}」的余额与流水不一致，无法自动合并；请核对两份账本`);
  }
}

// 只合并同一账本的完整延续；分支交易不自动累加，以免重复入账。
export function mergeAccounts(current, incoming) {
  const members = current.members.map(member => ({ ...member }));
  const ledgers = normalizeRefunds(current.ledgers);
  const backupLedgers = normalizeRefunds(incoming.ledgers);
  const currentIndex = indexLedgers(ledgers), backupIndex = indexLedgers(backupLedgers);
  const idMap = new Map(members.map(member => [member.id, member]));
  // 先为整份备份保留固定 ID 匹配，避免复用的旧手机号抢占另一位会员。
  const incomingIds = new Set(incoming.members.map(member => member.id));
  const incomingPhoneOwners = new Map(incoming.members.filter(member => !member.isArchived)
    .map(member => [normalizeMemberPhone(member.phone), member.id]));
  const phoneMap = new Map(members.filter(member => !member.isArchived && normalizeMemberPhone(member.phone) && !incomingIds.has(member.id))
    .map(member => [normalizeMemberPhone(member.phone), member]));
  const ledgerMap = new Map(ledgers.map(record => [record.id, record]));
  const historyOrder = new Map(ledgers.map((record, index) => [record.id, index]));
  const usedCurrentIds = new Set();
  let newMembersAdded = 0;
  let updatedMembers = 0;

  for (const backupMember of incoming.members) {
    const currentMember = idMap.get(backupMember.id) ||
      (!backupMember.isArchived && phoneMap.get(normalizeMemberPhone(backupMember.phone)));
    if (currentMember && usedCurrentIds.has(currentMember.id)) {
      throw new Error('备份中的多个会员指向同一档案，无法自动合并');
    }
    const finalId = currentMember?.id || backupMember.id;
    const backupHistory = (backupIndex.byMember.get(backupMember.id) || [])
      .map(record => ({ ...record, memberId: finalId }));
    for (const record of backupHistory) {
      const existing = ledgerMap.get(record.id);
      if (existing && ['memberId', 'type', 'changeAmount', 'balanceBefore', 'balanceAfter', 'originalLedgerId']
        .some(field => existing[field] !== record[field])) {
        throw new Error(`流水「${record.id}」存在冲突，无法自动合并`);
      }
    }
    if (!currentMember) {
      const added = { ...backupMember };
      members.push(added);
      idMap.set(added.id, added);
      if (!added.isArchived && normalizeMemberPhone(added.phone)) phoneMap.set(normalizeMemberPhone(added.phone), added);
      if (!added.isArchived) newMembersAdded++;
      backupHistory.forEach((record, index) => historyOrder.set(record.id, index));
    } else {
      usedCurrentIds.add(currentMember.id);
      const previousMember = { ...currentMember };
      const currentHistory = currentIndex.byMember.get(currentMember.id) || [];
      const currentIds = new Set(currentHistory.map(record => record.id));
      const backupIds = new Set(backupHistory.map(record => record.id));
      const newRecords = backupHistory.filter(record => !currentIds.has(record.id));
      const localOnly = currentHistory.filter(record => !backupIds.has(record.id));
      if (newRecords.length && localOnly.length) {
        throw new Error(`会员「${currentMember.name}」的两份账本都有独立交易，无法自动合并；请核对后选择完整账本恢复`);
      }
      if (newRecords.length) {
        assertExtension(currentMember, backupMember, newRecords, backupIndex.byId);
        backupHistory.forEach((record, index) => historyOrder.set(record.id, index));
        for (const field of financialFields) currentMember[field] = backupMember[field];
      } else {
        assertExtension(backupMember, currentMember, localOnly, currentIndex.byId);
      }

      const incomingTime = Date.parse(backupMember.updated_at);
      const currentTime = Date.parse(currentMember.updated_at);
      const phoneOwner = incomingPhoneOwners.get(normalizeMemberPhone(currentMember.phone));
      // 同一毫秒内改号并复用旧号时，按固定 ID 对应的号码归属同步资料。
      const phoneReassigned = currentMember.id === backupMember.id && phoneOwner && phoneOwner !== backupMember.id;
      if (newRecords.length || (!localOnly.length && (incomingTime > currentTime ||
          (incomingTime === currentTime && phoneReassigned)))) {
        for (const field of ['name', 'phone', 'notes', 'updated_at']) currentMember[field] = backupMember[field];
      }
      if (newRecords.length || (!localOnly.length && backupMember.isArchived)) {
        // 新交易确认后采用其档案状态；相同流水的注销状态保持单向，旧备份不能重新启用。
        currentMember.isArchived = newRecords.length ? Boolean(backupMember.isArchived) : true;
        if (!currentMember.isArchived) delete currentMember.deleted_at;
        else if (backupMember.deleted_at !== undefined &&
            (newRecords.length || !previousMember.isArchived || incomingTime > currentTime)) {
          currentMember.deleted_at = backupMember.deleted_at;
        }
      }
      if (!currentMember.notes && backupMember.notes) currentMember.notes = backupMember.notes;
      if (Date.parse(backupMember.created_at) < Date.parse(currentMember.created_at)) {
        currentMember.created_at = backupMember.created_at;
      }
      if (newRecords.length || ['name', 'phone', 'notes', 'updated_at', 'isArchived', 'deleted_at']
        .some(field => currentMember[field] !== previousMember[field])) updatedMembers++;
    }
    for (const record of backupHistory) {
      const existing = ledgerMap.get(record.id);
      if (existing) existing.isRefunded = Boolean(existing.isRefunded || record.isRefunded);
      else {
        ledgers.push(record);
        ledgerMap.set(record.id, record);
      }
    }
  }
  // 任何重复冲正或缺失关联都会在写入前阻断。
  const mergedLedgers = normalizeRefunds(ledgers);
  const mergedIndex = indexLedgers(mergedLedgers);
  const sortTimes = new Map();
  for (const member of members) {
    const history = (mergedIndex.byMember.get(member.id) || [])
      .sort((a, b) => historyOrder.get(b.id) - historyOrder.get(a.id));
    let lastTime = 0;
    for (const record of history) {
      lastTime = Math.max(lastTime, Date.parse(record.created_at));
      sortTimes.set(record.id, lastTime);
    }
  }
  mergedLedgers.sort((a, b) => sortTimes.get(b.id) - sortTimes.get(a.id) ||
    a.memberId.localeCompare(b.memberId) || historyOrder.get(a.id) - historyOrder.get(b.id));
  validateActiveMemberPhones(members);
  validateAccountHistory(members, mergedLedgers);
  return {
    members, ledgers: mergedLedgers, newMembersAdded, updatedMembers,
    newLedgersAdded: mergedLedgers.length - current.ledgers.length
  };
}
