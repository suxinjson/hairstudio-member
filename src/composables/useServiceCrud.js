import { ref } from 'vue';
import { canonicalJSON } from '../sync-protocol.js';

export function useServiceCrud({ localDb, hairServices, showToast, showFeedback, askConfirm }) {
  const showServiceModal = ref(false);
  const isSavingService = ref(false);
  let editBaseline = null;
  const serviceForm = ref({
    id: '',
    name: '',
    price: 38
  });

  function openAddServiceModal() {
    editBaseline = null;
    serviceForm.value = { id: '', name: '', price: 38 };
    showServiceModal.value = true;
  }

  function openEditServiceModal(s) {
    editBaseline = canonicalJSON(hairServices.value);
    serviceForm.value = { id: s.id, name: s.name, price: s.price };
    showServiceModal.value = true;
  }

  async function submitServiceForm() {
    if (isSavingService.value) return;
    isSavingService.value = true;
    try {
      if (serviceForm.value.id && canonicalJSON(localDb.getServices()) !== editBaseline) {
        throw new Error('服务项目已变化，请重新打开编辑窗口核对名称和价格后保存');
      }
      const result = localDb.saveService(serviceForm.value);
      if (result?.then) await result;
      showServiceModal.value = false;
      showToast('服务项目已更新');
      hairServices.value = localDb.getServices();
    } catch (err) {
      showFeedback(err.message);
    } finally {
      isSavingService.value = false;
    }
  }

  async function deleteServiceItem(id) {
    const confirmed = await askConfirm({
      title: '删除服务确认',
      message: '确定要删除该服务项目吗？\n已有的记账流水不会受到任何影响。',
      confirmText: '确认删除',
      cancelText: '取消',
      danger: true
    });
    if (!confirmed) return;
    try {
      let services = localDb.deleteService(id);
      if (services?.then) services = await services;
      hairServices.value = services;
      showToast('服务项目已删除');
    } catch (err) { showFeedback(err.message); }
  }

  return {
    showServiceModal,
    isSavingService,
    serviceForm,
    openAddServiceModal,
    openEditServiceModal,
    submitServiceForm,
    deleteServiceItem
  };
}
