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
    const current = localDb.getMemberById(item.memberId);
    const balanceAfter = (current?.balance || 0) - item.changeAmount;
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

    try {
      const refund = localDb.refundLedger(item.id, '店主手工撤销', balanceAfter < 0);
      refreshAll();
      if (selectedMember.value && selectedMember.value.id === item.memberId) {
        selectedMember.value = localDb.getMemberById(item.memberId);
      }
      showToast('已成功冲正流水');
    } catch (err) {
      showFeedback(err.message, 'error', { title: '撤单冲正失败' });
    }
  }

  return {
    confirmRefundLedger
  };
}
