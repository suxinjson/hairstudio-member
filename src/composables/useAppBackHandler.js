import { App as CapacitorApp } from '@capacitor/app';

export function useAppBackHandler({
  exitApp,
  showToast,
  confirmModal,
  handleConfirmModalCancel,
  feedbackModal,
  receiptModal,
  backupRestoreRequest,
  showServiceModal,
  showMemberModal,
  consumeConfirmation,
  rechargeConfirmation,
  rechargingMember,
  consumingMember,
  showConsumeKeypad,
  closeConsumeModal,
  selectedMember,
  activeTab,
  settingsPath,
  cloudLocked,
  backInSettings
}) {
  let exitPressCount = 0;
  let exitResetTimer = null;

  function resetExitSequence() {
    exitPressCount = 0;
    clearTimeout(exitResetTimer);
  }

  function closeTopLayer() {
    if (confirmModal.value) {
      handleConfirmModalCancel();
      return true;
    }
    if (feedbackModal.value) {
      feedbackModal.value = null;
      return true;
    }
    if (receiptModal.value) {
      receiptModal.value = null;
      return true;
    }
    if (backupRestoreRequest.value) {
      backupRestoreRequest.value = null;
      return true;
    }
    if (showServiceModal.value) {
      showServiceModal.value = false;
      return true;
    }
    if (showMemberModal.value) {
      showMemberModal.value = false;
      return true;
    }
    if (consumeConfirmation.value) {
      consumeConfirmation.value = null;
      return true;
    }
    if (rechargeConfirmation.value) {
      rechargeConfirmation.value = null;
      return true;
    }
    if (rechargingMember.value) {
      rechargingMember.value = null;
      return true;
    }
    if (consumingMember.value) {
      if (showConsumeKeypad.value) {
        showConsumeKeypad.value = false;
        return true;
      }
      closeConsumeModal();
      return true;
    }
    if (selectedMember.value) {
      selectedMember.value = null;
      return true;
    }
    if (activeTab.value === 'settings' && settingsPath.value.length && !cloudLocked.value) {
      backInSettings();
      return true;
    }
    if (activeTab.value !== 'customers' && !cloudLocked.value) {
      activeTab.value = 'customers';
      return true;
    }
    return false;
  }

  async function handleBackButton() {
    if (closeTopLayer()) {
      resetExitSequence();
      return;
    }
    exitPressCount += 1;
    clearTimeout(exitResetTimer);
    if (exitPressCount >= 3) {
      resetExitSequence();
      try {
        if (exitApp) {
          await exitApp();
        } else {
          await CapacitorApp.exitApp();
        }
      } catch {
        showToast('暂时无法退出，请重试');
      }
      return;
    }
    showToast(exitPressCount === 1 ? '再按两次返回键退出应用' : '再按一次返回键退出应用');
    exitResetTimer = setTimeout(resetExitSequence, 2000);
  }

  function handleWindowKeydown(e) {
    if (e.key === 'Escape') {
      handleBackButton();
    }
  }

  return {
    resetExitSequence,
    closeTopLayer,
    handleBackButton,
    handleWindowKeydown
  };
}
