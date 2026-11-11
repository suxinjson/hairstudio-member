export function useLedgerRefund({
  localDb,
  refreshAll,
  selectedMember,
  askConfirm,
  showToast,
  showFeedback,
  formatCent
}) {
  async function confirmRefundLedger(item) {
    const amountYuan = Math.abs(item.changeAmount / 100).toFixed(2);
    const actionText = item.type === 'CONSUME' ? `撤销扣款并退还 ¥${amountYuan}` : `撤销充值并扣回 ¥${amountYuan}`;
    const readMember = () => localDb.getMemberById(item.memberId) ||
      localDb.readBackupState().members.find(member => member.id === item.memberId);
    try {
      for (;;) {
        const current = readMember();
        if (!current) throw new Error('关联会员不存在');
        const balanceAfter = current.balance - item.changeAmount;
        const balancePrompt =
          balanceAfter < 0
            ? `\n\n⚠️ 注意：撤销充值后，会员余额将变为负数（欠款 ¥${formatCent(Math.abs(balanceAfter))}），需后续结清。`
            : `\n\n撤销后会员余额变更为：¥${formatCent(Math.abs(balanceAfter))} 元。`;

        const confirmed = await askConfirm({
          title: '撤单冲正确认',
          message: `确定要撤销这笔流水吗？\n会员：${item.memberName || '散客'}\n金额：${actionText}${balancePrompt}`,
          confirmText: '确认撤销冲正',
          cancelText: '取消',
          danger: true
        });
        if (!confirmed) return;

        const latest = readMember();
        if (!latest) throw new Error('关联会员不存在');
        if (latest.balance !== current.balance || Boolean(latest.isArchived) !== Boolean(current.isArchived)) {
          refreshAll();
          showToast('会员余额或档案状态已变化，请重新核对撤销后的余额和欠款。');
          continue;
        }
        const result = localDb.refundLedger(item.id, '店主手工撤销', balanceAfter < 0);
        if (result?.then) await result;
        refreshAll();
        if (selectedMember.value && selectedMember.value.id === item.memberId) {
          selectedMember.value = localDb.getMemberById(item.memberId);
        }
        showToast('已成功冲正流水');
        return;
      }
    } catch (err) {
      showFeedback(err.message, 'error', { title: '撤单冲正失败' });
    }
  }

  return {
    confirmRefundLedger
  };
}
