import { ref, computed, watch } from 'vue';
import { isValidMoney, moneyToCent } from '../money.js';
import { rechargeGiftCent } from '../recharge-settings.js';

export function useRecharge({
  localDb,
  rechargeSettings,
  refreshAll,
  selectedMember,
  receiptModal,
  showToast,
  showFeedback,
  formatCent
}) {
  const rechargingMember = ref(null);
  const rechargeForm = ref({
    actualPay: '',
    giftAmount: 0,
    payMethod: '',
    remark: ''
  });
  const rechargeConfirmation = ref(null);
  const isSubmittingRecharge = ref(false);

  function openRechargeModal(m) {
    rechargeSettings.value = localDb.getRechargeSettings();
    rechargingMember.value = localDb.getMemberById(m.id) || m;
    rechargeConfirmation.value = null;
    isSubmittingRecharge.value = false;
    rechargeForm.value = {
      actualPay: '',
      giftAmount: 0,
      payMethod: '',
      remark: ''
    };
  }

  function applyRechargePlan(plan) {
    rechargeForm.value.actualPay = plan.pay;
    updateRechargeGift();
  }

  function updateRechargeGift() {
    try {
      rechargeForm.value.giftAmount = rechargeGiftCent(rechargeForm.value.actualPay || 0, rechargeSettings.value) / 100;
    } catch {
      rechargeForm.value.giftAmount = 0;
    }
  }

  watch([() => rechargeSettings.value.giftEnabled, () => rechargeSettings.value.giftRate], () => {
    if (rechargingMember.value) updateRechargeGift();
    else if (!rechargeSettings.value.giftEnabled) rechargeForm.value.giftAmount = 0;
  });

  const rechargeCreditCent = computed(() => {
    try {
      const credit = moneyToCent(rechargeForm.value.actualPay || 0) + (rechargeSettings.value.giftEnabled ? moneyToCent(rechargeForm.value.giftAmount || 0) : 0);
      return Number.isSafeInteger(credit) ? credit : 0;
    } catch {
      return 0;
    }
  });

  const rechargeBalanceAfter = computed(() => (rechargingMember.value?.balance || 0) + rechargeCreditCent.value);

  const canSubmitRecharge = computed(() => {
    return isValidMoney(rechargeForm.value.actualPay) && Number(rechargeForm.value.actualPay) > 0 &&
      (!rechargeSettings.value.giftEnabled || isValidMoney(rechargeForm.value.giftAmount === '' ? 0 : rechargeForm.value.giftAmount)) &&
      rechargeCreditCent.value > 0 && Number.isSafeInteger(rechargeBalanceAfter.value);
  });

  function requestRechargeConfirmation() {
    if (!rechargingMember.value || isSubmittingRecharge.value) return;
    const policy = localDb.getRechargeSettings();
    if (policy.giftEnabled !== rechargeSettings.value.giftEnabled || policy.giftRate !== rechargeSettings.value.giftRate) {
      rechargeSettings.value = policy;
      updateRechargeGift();
    }
    if (!canSubmitRecharge.value) {
      showFeedback('请填写大于 0 的实收金额，赠送额度可以填写 0。');
      return;
    }

    const current = localDb.getMemberById(rechargingMember.value.id);
    if (!current) {
      showFeedback('客户不存在或已注销。');
      return;
    }
    rechargingMember.value = current;
    if (!policy.giftEnabled) rechargeForm.value.giftAmount = 0;
    const credit = moneyToCent(rechargeForm.value.actualPay) + moneyToCent(rechargeForm.value.giftAmount || 0);
    if (!Number.isSafeInteger(credit) || !Number.isSafeInteger(current.balance + credit)) {
      showFeedback('充值金额超出可处理范围。', 'error');
      return;
    }
    rechargeConfirmation.value = {
      memberId: rechargingMember.value.id,
      memberName: rechargingMember.value.name,
      actualPay: Number(rechargeForm.value.actualPay),
      giftAmount: Number(rechargeForm.value.giftAmount),
      rechargeSettings: policy,
      payMethod: rechargeForm.value.payMethod,
      remark: rechargeForm.value.remark,
      currentBalance: current.balance,
      balanceAfter: current.balance + credit,
      debtRepaid: Math.min(Math.max(0, -current.balance), credit)
    };
  }

  function confirmRecharge() {
    const confirmation = rechargeConfirmation.value;
    if (!confirmation || isSubmittingRecharge.value) return;
    const current = localDb.getMemberById(confirmation.memberId);
    const currentPolicy = localDb.getRechargeSettings();
    if (JSON.stringify(currentPolicy) !== JSON.stringify(confirmation.rechargeSettings)) {
      rechargeSettings.value = currentPolicy;
      updateRechargeGift();
      requestRechargeConfirmation();
      showToast('赠送规则已变化，请重新核对充值结果。');
      return;
    }
    if (!current || current.balance !== confirmation.currentBalance) {
      requestRechargeConfirmation();
      showToast('客户余额已变化，请重新核对充值结果。');
      return;
    }
    isSubmittingRecharge.value = true;

    try {
      const res = localDb.recharge({
        memberId: confirmation.memberId,
        actualPay: confirmation.actualPay,
        giftAmount: confirmation.giftAmount,
        payMethod: confirmation.payMethod,
        remark: confirmation.remark
      });

      const memberName = confirmation.memberName;
      const totalCredit = res.totalCredit / 100;
      const balanceAfter = (Math.abs(res.balanceAfter) / 100).toFixed(2);
      const balanceText = res.balanceAfter < 0 ? `当前仍欠款：¥${balanceAfter} 元，请后续结清。` : `当前可用余额：¥${balanceAfter} 元。`;
      const repaymentText = confirmation.debtRepaid > 0 ? `\n本次抵扣欠款：¥${formatCent(confirmation.debtRepaid)} 元` : '';

      rechargingMember.value = null;
      rechargeConfirmation.value = null;
      showToast('充值成功！');

      receiptModal.value = {
        name: memberName,
        messageText: `【梦飞空间会员充值通知】\n尊敬的 ${memberName}，您好！\n本次充值已成功入账：¥${totalCredit.toFixed(2)} 元${repaymentText}\n${balanceText}\n感谢您的支持与惠顾，祝您生活愉快！`
      };

      refreshAll();
      if (selectedMember.value) {
        selectedMember.value = localDb.getMemberById(selectedMember.value.id);
      }
    } catch (err) {
      showFeedback(err.message, 'error', { title: '充值失败' });
    } finally {
      isSubmittingRecharge.value = false;
    }
  }

  return {
    rechargingMember,
    rechargeForm,
    rechargeConfirmation,
    isSubmittingRecharge,
    rechargeCreditCent,
    rechargeBalanceAfter,
    canSubmitRecharge,
    openRechargeModal,
    applyRechargePlan,
    updateRechargeGift,
    requestRechargeConfirmation,
    confirmRecharge
  };
}
