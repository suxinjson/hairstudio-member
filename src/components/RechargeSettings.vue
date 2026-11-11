<template>
  <section class="recharge-settings-card">
    <form @submit.prevent="emit('save')">
      <div class="recharge-setting-heading">
        <div>
          <h3>充值赠送设置</h3>
          <p>关闭后，充值只按实收金额到账。</p>
        </div>
        <label class="recharge-setting-switch">
          <input 
            v-model="form.giftEnabled" 
            @change="emit('change-switch')"
            type="checkbox" 
            role="switch" 
            aria-label="允许充值赠送" 
            :disabled="isSaving || !canWrite('saveRechargeSettings')"
          />
          <span>允许赠送</span>
        </label>
      </div>
      <label v-if="form.giftEnabled" class="recharge-rate-label" for="recharge-gift-rate">赠送比例
        <div>
          <input 
            id="recharge-gift-rate" 
            v-model.number="form.giftRate" 
            @input="emit('input-rate')"
            type="number" 
            inputmode="decimal" 
            min="0" 
            max="100" 
            step="0.01" 
            required 
            :disabled="isSaving || !canWrite('saveRechargeSettings')"
          />
          <span>%</span>
        </div>
      </label>
      <p v-if="form.giftEnabled" class="recharge-rate-example">
        例如 {{ form.giftRate || 0 }}%：充值 200 元，赠送 ¥{{ example }}。
      </p>
      <button 
        type="submit" 
        :disabled="isSaving || !canWrite('saveRechargeSettings') || !canSave"
        class="recharge-settings-save"
      >
        保存赠送设置
      </button>
      <button v-if="isDirty" type="button" :disabled="isSaving" class="recharge-settings-save" @click="emit('reload')">
        重新加载已保存设置
      </button>
    </form>
  </section>
</template>

<script setup>
defineProps({
  form: { type: Object, required: true },
  canWrite: { type: Function, default: () => true },
  canSave: Boolean,
  isDirty: Boolean,
  isSaving: Boolean,
  example: { type: String, default: '—' }
});

const emit = defineEmits(['save', 'reload', 'change-switch', 'input-rate']);
</script>
