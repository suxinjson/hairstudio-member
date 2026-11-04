import { ref, computed } from 'vue';
import { isValidMoney, moneyToCent } from '../money.js';

export function useConsume({
  localDb,
  hairServices,
  refreshAll,
  selectedMember,
  showToast,
  showFeedback,
  formatCent,
  openRechargeModal
}) {
  const consumingMember = ref(null);
  const consumeAmountStr = ref('');
  const consumeSummary = ref('精致洗剪吹');
  const isSubmittingConsume = ref(false);
  const showConsumeKeypad = ref(true);
  const consumeConfirmation = ref(null);
  const debtAcknowledged = ref(false);

  function openConsumeModal(m) {
    consumingMember.value = localDb.getMemberById(m.id) || m;
    consumeConfirmation.value = null;
    isSubmittingConsume.value = false;
    const first = hairServices.value[0];
    consumeAmountStr.value = first ? first.price.toString() : '';
    consumeSummary.value = first ? first.name : '精致洗剪吹';
    showConsumeKeypad.value = false;
    debtAcknowledged.value = false;
  }

  function handleConsumeModalBack() {
    if (showConsumeKeypad.value) {
      showConsumeKeypad.value = false;
      return;
    }
    closeConsumeModal();
  }

  function closeConsumeModal() {
    consumingMember.value = null;
    consumeConfirmation.value = null;
  }

  function openConsumeKeypad() {
    document.activeElement?.blur?.();
    showConsumeKeypad.value = true;
  }

  function toggleConsumeKeypad() {
    if (showConsumeKeypad.value) showConsumeKeypad.value = false;
    else openConsumeKeypad();
  }

  function clearConsumeAmount() {
    consumeAmountStr.value = '';
    openConsumeKeypad();
  }

  function setConsumePreset(item) {
    document.activeElement?.blur?.();
    consumeAmountStr.value = item.price.toString();
    consumeSummary.value = item.name;
    showConsumeKeypad.value = false;
  }

  const consumeBalanceAfter = computed(() => {
    if (!consumingMember.value || !consumeAmountStr.value || !isValidMoney(consumeAmountStr.value)) return null;
    return consumingMember.value.balance - moneyToCent(consumeAmountStr.value);
  });

  const consumeDebtAdded = computed(() => {
    return consumeBalanceAfter.value === null
      ? 0
      : Math.max(0, -consumeBalanceAfter.value) - Math.max(0, -consumingMember.value.balance);
  });

  const isConsumeOverBalance = computed(() => {
    return canSubmitConsume.value && consumeBalanceAfter.value < 0;
  });

  const canSubmitConsume = computed(() => {
    if (!consumingMember.value) return false;
    if (!consumeAmountStr.value) return false;
    if (!isValidMoney(consumeAmountStr.value)) return false;
    const num = parseFloat(consumeAmountStr.value);
    if (num <= 0) return false;
    return Number.isSafeInteger(consumeBalanceAfter.value) &&
      Number.isSafeInteger(consumingMember.value.total_consume + moneyToCent(consumeAmountStr.value));
  });

  function requestConsumeConfirmation() {
    if (!consumingMember.value || isSubmittingConsume.value) return;
    if (!consumeAmountStr.value || !isValidMoney(consumeAmountStr.value)) {
      showFeedback('请输入有效的扣款金额。');
      return;
    }
    const amountNum = parseFloat(consumeAmountStr.value);
    if (amountNum <= 0) {
      showFeedback('请输入大于 0 的有效扣款金额。');
      return;
    }
    const amountCent = moneyToCent(consumeAmountStr.value);
    const current = localDb.getMemberById(consumingMember.value.id);
    if (!current) {
      showFeedback('客户不存在或已注销。', 'error');
      return;
    }
    consumingMember.value = current;
    if (!canSubmitConsume.value) {
      showFeedback('扣款金额超出可处理范围。', 'error');
      return;
    }
    debtAcknowledged.value = false;

    consumeConfirmation.value = {
      memberId: consumingMember.value.id,
      memberName: consumingMember.value.name,
      memberPhone: consumingMember.value.phone,
      currentBalance: consumingMember.value.balance,
      amount: amountNum,
      amountCent,
      balanceAfter: consumingMember.value.balance - amountCent,
      debtAdded: consumeDebtAdded.value,
      itemsSummary: consumeSummary.value.trim() || '精致洗剪吹'
    };
  }

  function confirmConsume() {
    const conf = consumeConfirmation.value;
    if (!conf || isSubmittingConsume.value) return;
    if (conf.balanceAfter < 0 && !debtAcknowledged.value) return;
    const current = localDb.getMemberById(conf.memberId);
    if (!current) {
      consumeConfirmation.value = null;
      showFeedback('客户不存在或已注销。', 'error');
      return;
    }
    if (current.balance !== conf.currentBalance) {
      requestConsumeConfirmation();
      showToast('客户余额已变化，请重新核对金额和欠款。');
      return;
    }
    isSubmittingConsume.value = true;
    try {
      const result = localDb.consume({
        memberId: conf.memberId,
        amount: conf.amount,
        itemsSummary: conf.itemsSummary,
        allowDebt: conf.balanceAfter < 0 && debtAcknowledged.value
      });

      const memberName = conf.memberName;
      const deductedCent = result.deductedAmount;
      const balanceAfterCent = result.balanceAfter;

      consumeConfirmation.value = null;
      consumingMember.value = null;

      refreshAll();
      if (selectedMember.value) {
        selectedMember.value = localDb.getMemberById(selectedMember.value.id);
      }
      showFeedback(
        balanceAfterCent < 0
          ? `本次已记录新增欠款 ¥${formatCent(conf.debtAdded)}，请记得收款结清。`
          : '本次服务已记入会员账本。',
        'success',
        {
          title: balanceAfterCent < 0 ? '扣款成功 · 已记录欠款' : '消费成功',
          amount: (deductedCent / 100).toFixed(2),
          memberName,
          balance: (balanceAfterCent / 100).toFixed(2),
          debt: balanceAfterCent < 0 ? formatCent(-balanceAfterCent) : null
        }
      );
    } catch (err) {
      showFeedback(err.message, 'error', { title: '扣款失败' });
    } finally {
      isSubmittingConsume.value = false;
    }
  }

  function rechargeFromConsume() {
    if (!consumingMember.value) return;
    const member = consumingMember.value;
    closeConsumeModal();
    openRechargeModal(member);
  }

  return {
    consumingMember,
    consumeAmountStr,
    consumeSummary,
    isSubmittingConsume,
    showConsumeKeypad,
    consumeConfirmation,
    debtAcknowledged,
    consumeBalanceAfter,
    consumeDebtAdded,
    isConsumeOverBalance,
    canSubmitConsume,
    openConsumeModal,
    handleConsumeModalBack,
    closeConsumeModal,
    openConsumeKeypad,
    toggleConsumeKeypad,
    clearConsumeAmount,
    setConsumePreset,
    requestConsumeConfirmation,
    confirmConsume,
    rechargeFromConsume
  };
}
