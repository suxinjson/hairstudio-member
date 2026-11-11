import { ref, computed } from 'vue';
import { DEFAULT_RECHARGE_SETTINGS, normalizeRechargeSettings, rechargeGiftCent } from '../recharge-settings.js';

export function useRechargeSettings({ localDb, showToast, showFeedback, formatCent }) {
  const rechargeSettings = ref({ ...DEFAULT_RECHARGE_SETTINGS });
  const rechargeSettingsForm = ref({ ...DEFAULT_RECHARGE_SETTINGS });
  const rechargeSettingsDirty = ref(false);
  const saving = ref(false);

  function changeRechargeGiftSwitch() {
    rechargeSettingsDirty.value = true;
    if (!rechargeSettingsForm.value.giftEnabled) {
      try {
        normalizeRechargeSettings(rechargeSettingsForm.value);
      } catch {
        rechargeSettingsForm.value.giftRate = rechargeSettings.value.giftRate || 0;
      }
    }
  }

  const canSaveRechargeSettings = computed(() => {
    try {
      normalizeRechargeSettings(rechargeSettingsForm.value);
      return true;
    } catch {
      return false;
    }
  });

  const rechargeSettingsExample = computed(() => {
    try {
      return formatCent(rechargeGiftCent(200, rechargeSettingsForm.value));
    } catch {
      return '0.00';
    }
  });

  async function saveRechargeSettingsForm() {
    if (saving.value) return;
    saving.value = true;
    try {
      let saved = localDb.saveRechargeSettings(rechargeSettingsForm.value);
      if (saved?.then) saved = await saved;
      rechargeSettings.value = saved;
      rechargeSettingsForm.value = { ...saved };
      rechargeSettingsDirty.value = false;
      showToast('充值赠送设置已保存');
    } catch (err) {
      showFeedback(err.message, 'error', { title: '保存设置失败' });
    } finally {
      saving.value = false;
    }
  }

  return {
    rechargeSettings,
    rechargeSettingsForm,
    rechargeSettingsDirty,
    changeRechargeGiftSwitch,
    canSaveRechargeSettings,
    rechargeSettingsExample,
    saveRechargeSettingsForm
  };
}
