<template>
  <section class="bg-white rounded-3xl border border-slate-200 p-5 space-y-5">
    <div><h2 class="text-xl font-black">门店设置</h2><p class="text-sm text-slate-500 mt-2">软件名称为“会员管家”，以下内容按自己的门店配置。</p></div>
    <p v-if="!canEdit" class="text-slate-600">仅店主可以修改门店设置。</p>
    <p v-if="error" role="alert" class="rounded-xl p-3 bg-rose-50 text-rose-700">{{ error }}</p>
    <p v-if="message" role="status" class="rounded-xl p-3 bg-emerald-50 text-emerald-700">{{ message }}</p>
    <form @submit.prevent="save" class="space-y-4">
      <label class="block font-bold">门店名称<input v-model="form.name" required maxlength="128" :disabled="!canEdit || saving" class="block border rounded-xl p-3 w-full mt-2" /></label>
      <label class="block font-bold">联系电话<input v-model="form.phone" type="tel" maxlength="64" :disabled="!canEdit || saving" class="block border rounded-xl p-3 w-full mt-2" /></label>
      <label class="block font-bold">门店地址<input v-model="form.address" maxlength="256" :disabled="!canEdit || saving" class="block border rounded-xl p-3 w-full mt-2" /></label>
      <label class="block font-bold">会员备注标题<input v-model="form.memberNotesLabel" required maxlength="32" :disabled="!canEdit || saving" class="block border rounded-xl p-3 w-full mt-2" /><small class="text-slate-500 font-normal">例如：服务偏好、注意事项、客户需求</small></label>
      <label class="block font-bold">语音欢迎词<textarea v-model="form.welcomeText" required maxlength="200" :disabled="!canEdit || saving" rows="2" class="block border rounded-xl p-3 w-full mt-2" /><small class="text-slate-500 font-normal">用 {store} 自动带入门店名称。</small></label>
      <label class="block font-bold">充值通知致谢<textarea v-model="form.rechargeThanks" maxlength="300" :disabled="!canEdit || saving" rows="3" class="block border rounded-xl p-3 w-full mt-2" /></label>
      <p class="text-sm text-slate-500">服务项目、价格和充值赠送规则在“服务与价格”中设置。</p>
      <div class="flex gap-3"><button v-if="canEdit" :disabled="saving || !dirty" type="submit" class="rounded-xl p-4 bg-indigo-700 text-white font-bold disabled:opacity-50">{{ saving ? '正在保存…' : '保存门店设置' }}</button>
        <button v-if="loadProfile" @click="reload" type="button" :disabled="saving" class="rounded-xl p-4 border font-bold">重新加载</button></div>
    </form>
  </section>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { normalizeStoreProfile } from '../store-profile.js';
const props = defineProps({ profile: Object, canEdit: { type: Boolean, default: true }, saveProfile: { type: Function, required: true }, loadProfile: Function });
const initial = normalizeStoreProfile(props.profile || {});
const base = ref(initial), form = ref({ ...initial }), saving = ref(false), error = ref(''), message = ref('');
const dirty = computed(() => JSON.stringify(form.value) !== JSON.stringify(base.value));
watch(() => props.profile, profile => { if (!dirty.value && !saving.value) { base.value = normalizeStoreProfile(profile || {}); form.value = { ...base.value }; } });
async function save() {
  if (!props.canEdit || saving.value) return;
  saving.value = true; error.value = ''; message.value = '';
  try { const saved = await props.saveProfile(normalizeStoreProfile(form.value), base.value.version); if (!saved) throw new Error('门店设置未保存，请稍后重试'); base.value = normalizeStoreProfile(saved); form.value = { ...base.value }; message.value = '门店设置已保存'; }
  catch (e) { error.value = e.message; } finally { saving.value = false; }
}
async function reload() {
  if (saving.value) return; saving.value = true; error.value = ''; message.value = '';
  try { base.value = normalizeStoreProfile(await props.loadProfile()); form.value = { ...base.value }; }
  catch (e) { error.value = e.message; } finally { saving.value = false; }
}
</script>
