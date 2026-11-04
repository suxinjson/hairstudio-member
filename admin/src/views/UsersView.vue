<template>
  <div class="space-y-6">
    <div class="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-6">
      <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
        <div>
          <h3 class="font-black text-slate-900 text-base">🛡️ 员工账号与权限管理</h3>
          <p class="text-xs text-slate-400 mt-0.5">为店内员工分配登录账号，细粒度隔离收银、对账与管理权限</p>
        </div>
        <button
          @click="openAddUser"
          class="h-9 px-3.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl text-xs font-black transition flex items-center gap-1"
        >
          <span>＋</span> 开通新员工账号
        </button>
      </div>

      <div v-if="loading" class="text-center py-10 text-slate-400 text-sm">
        正在拉取员工权限列表...
      </div>
      <div v-else-if="users.length === 0" class="text-center py-10 text-slate-400 text-sm">
        暂无其他员工账号
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-sm">
          <thead>
            <tr class="bg-slate-50/80 border-b border-slate-200 text-slate-500 font-bold text-xs uppercase">
              <th class="py-3 px-4 font-bold">员工姓名</th>
              <th class="py-3 px-4 font-bold">登录用户名</th>
              <th class="py-3 px-4 font-bold">岗位角色</th>
              <th class="py-3 px-4 font-bold">当前在用状态</th>
              <th class="py-3 px-4 font-bold text-right">权限管理</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 font-medium">
            <tr v-for="u in users" :key="u.id" class="hover:bg-slate-50/80 transition">
              <td class="py-3.5 px-4 font-black text-slate-900">
                {{ u.displayName }}
              </td>
              <td class="py-3.5 px-4 font-mono font-bold text-slate-600">
                {{ u.username }}
              </td>
              <td class="py-3.5 px-4">
                <span
                  class="px-2 py-0.5 rounded-lg text-xs font-bold"
                  :class="{
                    'bg-purple-100 text-purple-900': u.role === 'owner',
                    'bg-emerald-100 text-emerald-900': u.role === 'clerk',
                    'bg-slate-100 text-slate-700': u.role === 'viewer'
                  }"
                >
                  {{ u.role === 'owner' ? '👑 店主 (完全权限)' : u.role === 'clerk' ? '✂️ 收银 / 发型师' : '👀 外部审计员 (只读)' }}
                </span>
              </td>
              <td class="py-3.5 px-4">
                <span
                  class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold"
                  :class="u.active ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'"
                >
                  <span class="w-1.5 h-1.5 rounded-full" :class="u.active ? 'bg-emerald-500' : 'bg-rose-500'"></span>
                  <span>{{ u.active ? '正常在用' : '已停用' }}</span>
                </span>
              </td>
              <td class="py-3.5 px-4 text-right">
                <button
                  @click="toggleUserActive(u)"
                  class="px-3 py-1 rounded-lg text-xs font-bold transition"
                  :class="u.active ? 'bg-rose-50 text-rose-700 hover:bg-rose-100' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'"
                >
                  {{ u.active ? '停用账号' : '恢复启用' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 开通新员工弹窗 -->
    <div v-if="showAddModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div class="bg-white rounded-3xl p-6 w-full max-w-sm shadow-2xl border border-slate-100">
        <h3 class="text-lg font-black text-slate-900 mb-4">开通新员工账号</h3>

        <div class="space-y-3">
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">员工姓名 (显示名) *</label>
            <input
              v-model="newUserForm.displayName"
              type="text"
              placeholder="如：李发型师、王收银"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">登录用户名 *</label>
            <input
              v-model="newUserForm.username"
              type="text"
              placeholder="如：clerk01"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-mono font-bold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">初始登录密码 *</label>
            <input
              v-model="newUserForm.password"
              type="password"
              placeholder="至少6位密码"
              class="w-full h-10 px-3 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label class="block text-xs font-bold text-slate-600 mb-1">岗位角色 *</label>
            <select
              v-model="newUserForm.role"
              class="w-full h-10 px-2 bg-slate-50 border border-slate-300 rounded-xl text-xs font-bold focus:outline-none focus:border-emerald-600"
            >
              <option value="clerk">收银 / 发型师 (日常开单、扣款、充值)</option>
              <option value="viewer">外部审计员 (只读查看流水与报表)</option>
              <option value="owner">店主 (全权管理、批量导入、员工管理)</option>
            </select>
          </div>
        </div>

        <div v-if="modalError" class="mt-3 p-2 bg-rose-50 text-rose-700 text-xs font-bold rounded-lg">
          {{ modalError }}
        </div>

        <div class="mt-6 flex gap-2.5">
          <button
            @click="showAddModal = false"
            class="flex-1 h-11 rounded-xl bg-slate-100 text-slate-700 font-bold text-sm hover:bg-slate-200"
          >
            取消
          </button>
          <button
            @click="submitCreateUser"
            :disabled="!newUserForm.displayName.trim() || !newUserForm.username.trim() || !newUserForm.password || isSubmitting"
            class="flex-1 h-11 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-black text-sm disabled:opacity-50"
          >
            {{ isSubmitting ? '开通中...' : '确认开通' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { adminApi } from '../api/client.js';

const users = ref([]);
const loading = ref(false);
const showAddModal = ref(false);
const isSubmitting = ref(false);
const modalError = ref('');

const newUserForm = ref({
  displayName: '',
  username: '',
  password: '',
  role: 'clerk'
});

async function loadUsers() {
  loading.value = true;
  try {
    users.value = await adminApi.getUsers();
  } catch (err) {
    alert('加载员工权限失败: ' + err.message);
  } finally {
    loading.value = false;
  }
}

function openAddUser() {
  newUserForm.value = {
    displayName: '',
    username: '',
    password: '',
    role: 'clerk'
  };
  modalError.value = '';
  showAddModal.value = true;
}

async function submitCreateUser() {
  modalError.value = '';
  isSubmitting.value = true;
  try {
    await adminApi.createUser({
      displayName: newUserForm.value.displayName.trim(),
      username: newUserForm.value.username.trim(),
      password: newUserForm.value.password,
      role: newUserForm.value.role
    });
    showAddModal.value = false;
    await loadUsers();
  } catch (err) {
    modalError.value = err.message || '开通账号失败';
  } finally {
    isSubmitting.value = false;
  }
}

async function toggleUserActive(u) {
  if (!confirm(`确定要${u.active ? '停用' : '启用'}员工 [${u.displayName}] 的账号吗？`)) return;
  try {
    await adminApi.updateUser(u.id, {
      role: u.role,
      active: !u.active
    });
    await loadUsers();
  } catch (err) {
    alert('操作失败: ' + err.message);
  }
}

onMounted(() => {
  loadUsers();
});
</script>
