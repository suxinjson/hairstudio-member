<template>
  <details class="offline-activation">
    <summary>{{ state.binding?.mode === 'standalone' ? '续期授权与本地登录' : '独立离线授权与本地登录' }}</summary>
    <p>适用于独立本地使用。请将设备标识交给服务商获取授权码；授权期限自签发时起计算。</p>
    <label>本机设备标识<input :value="state.deviceId || '正在读取…'" readonly aria-label="本机授权设备标识" /></label>
    <button type="button" :disabled="!state.deviceId || busy || state.busy" @click="copy">复制设备标识</button>
    <p v-if="state.deviceAccess?.localUsername">本地账号：{{ state.deviceAccess.localUsername }}。{{ state.deviceAccess.authorizedUntil ? '到期：' + new Date(state.deviceAccess.authorizedUntil).toLocaleString() : '永久离线授权' }}</p>
    <form @submit.prevent="activate">
      <label>服务商签发的授权码<textarea v-model.trim="code" maxlength="12000" required rows="4" autocomplete="off" spellcheck="false" /></label>
      <label>设置本地登录密码<PasswordField v-model="password" required :minlength="12" :maxlength="128" autocomplete="new-password" :disabled="busy || state.busy" /></label>
      <label>确认密码<PasswordField v-model="confirmation" required :minlength="12" :maxlength="128" autocomplete="new-password" :disabled="busy || state.busy" /></label>
      <label class="acknowledgement"><input v-model="acknowledged" type="checkbox" required />我确认当前本机账本属于授权门店，并已妥善备份。</label>
      <button type="submit" :disabled="state.busy || busy || !state.deviceId">{{ busy ? '正在核验授权…' : '验证授权并登录本地账号' }}</button>
    </form>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
    <p class="footnote">离线模式不会自动上传账本，也无法接收远程禁用。请定期导出并保护备份；忘记本地密码可由持有有效授权码的管理员重新激活。</p>
  </details>
</template>
<script setup>
import { ref } from 'vue';
import PasswordField from './PasswordField.vue';
const props = defineProps({ state: { type: Object, required: true }, activateOffline: { type: Function, required: true }, copyText: { type: Function, required: true } });
const code = ref(''), password = ref(''), confirmation = ref(''), message = ref(''), busy = ref(false), acknowledged = ref(false), failed = ref(false);
async function copy() { try { await props.copyText(props.state.deviceId); message.value = '设备标识已复制'; } catch (error) { message.value = error.message; } }
async function activate() {
  if (busy.value || !acknowledged.value) return;
  if (password.value !== confirmation.value) { failed.value = true; message.value = '两次输入的密码不一致'; return; }
  busy.value = true; message.value = ''; failed.value = false;
  try { await props.activateOffline(code.value, password.value); code.value = ''; password.value = ''; confirmation.value = ''; message.value = '离线授权已生效，本地账号已登录'; }
  catch (error) { failed.value = true; message.value = error.message; }
  finally { busy.value = false; }
}
</script>
<style scoped>
.offline-activation{padding:1rem;border:1px solid #cbd5e1;border-radius:1rem;background:#f8fafc}.offline-activation summary{font-weight:700;cursor:pointer}.offline-activation p{font-size:.875rem;line-height:1.7;margin:.75rem 0;color:#475569}.offline-activation label{display:block;font-size:.875rem;margin:.75rem 0}.offline-activation input:not([type=checkbox]),.offline-activation textarea{display:block;width:100%;margin-top:.35rem;padding:.7rem;background:white;border:1px solid #cbd5e1;border-radius:.6rem;overflow-wrap:anywhere}.offline-activation input[readonly]{font-family:monospace;font-size:.8rem}.offline-activation button{border:1px solid #94a3b8;border-radius:.6rem;padding:.65rem 1rem;font-weight:700;background:white}.offline-activation button:disabled{opacity:.5}.acknowledgement{line-height:1.6}.offline-activation .footnote{font-size:.75rem}
</style>
