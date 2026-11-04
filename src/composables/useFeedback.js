import { ref, provide } from 'vue';

export function useFeedback() {
  const toastMessage = ref('');
  let toastTimer = null;
  const feedbackModal = ref(null);
  const confirmModal = ref(null);

  function showToast(msg) {
    clearTimeout(toastTimer);
    toastMessage.value = msg;
    toastTimer = setTimeout(() => {
      toastMessage.value = '';
    }, 2500);
  }

  function showFeedback(message, type = 'error', details = {}) {
    feedbackModal.value = {
      type,
      title: details.title || (type === 'success' ? '操作成功' : '操作未完成'),
      message,
      ...details
    };
  }

  function askConfirm(options) {
    if (typeof options === 'string') {
      options = { message: options };
    }
    return new Promise((resolve) => {
      confirmModal.value = {
        title: options.title || '操作确认',
        message: options.message,
        confirmText: options.confirmText || '确定',
        cancelText: options.cancelText || '取消',
        type: options.type || (options.danger ? 'danger' : 'warning'),
        resolve
      };
    });
  }

  function handleConfirmModalAccept() {
    const resolve = confirmModal.value?.resolve;
    confirmModal.value = null;
    resolve?.(true);
  }

  function handleConfirmModalCancel() {
    const resolve = confirmModal.value?.resolve;
    confirmModal.value = null;
    resolve?.(false);
  }

  provide('askConfirm', askConfirm);

  return {
    toastMessage,
    feedbackModal,
    confirmModal,
    showToast,
    showFeedback,
    askConfirm,
    handleConfirmModalAccept,
    handleConfirmModalCancel
  };
}
