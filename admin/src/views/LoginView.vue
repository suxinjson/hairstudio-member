<template>
  <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-emerald-950 p-6">
    <div class="w-full max-w-md bg-white rounded-3xl shadow-2xl p-8 border border-slate-200/80">
      <!-- 品牌标识与标题 -->
      <div class="text-center mb-8">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-50 text-3xl mb-3 shadow-inner border border-emerald-100">
          💈
        </div>
        <h1 class="text-2xl font-black text-slate-900 tracking-tight">梦飞空间会员管家</h1>
        <p class="text-sm text-slate-500 font-medium mt-1">PC 端后台管理中心 · 安全登录</p>
      </div>

      <!-- 登录表单 -->
      <form @submit.prevent="handleLogin" class="space-y-4">
        <div>
          <label class="block text-xs font-bold text-slate-600 mb-1.5" for="username">管理员账号 / 用户名</label>
          <div class="relative">
            <input
              id="username"
              v-model="username"
              type="text"
              required
              autocomplete="username"
              placeholder="请输入管理员账号"
              class="w-full h-11 px-3.5 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 transition"
            />
          </div>
        </div>

        <div>
          <label class="block text-xs font-bold text-slate-600 mb-1.5" for="password">登录密码</label>
          <div class="relative">
            <input
              id="password"
              v-model="password"
              :type="showPassword ? 'text' : 'password'"
              required
              autocomplete="current-password"
              placeholder="请输入登录密码"
              class="w-full h-11 px-3.5 pr-10 bg-slate-50 border border-slate-300 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600 transition"
            />
            <button
              type="button"
              @click="showPassword = !showPassword"
              class="absolute right-3 top-3 text-slate-400 hover:text-slate-600 text-xs font-bold"
              tabindex="-1"
            >
              {{ showPassword ? '隐藏' : '显示' }}
            </button>
          </div>
        </div>

        <!-- 错误提示 -->
        <div v-if="errorMessage" class="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs font-bold flex items-center gap-2">
          <span>⚠️</span>
          <span>{{ errorMessage }}</span>
        </div>

        <!-- 登录提交按钮 -->
        <button
          type="submit"
          :disabled="isSubmitting"
          class="w-full h-12 mt-2 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white rounded-xl font-black text-base shadow-lg shadow-emerald-700/25 transition btn-press flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <span v-if="isSubmitting" class="animate-spin text-lg">⏳</span>
          <span>{{ isSubmitting ? '安全校验登录中...' : '安全登录后台' }}</span>
        </button>
      </form>

      <!-- 底部安全提示 -->
      <div class="mt-8 pt-6 border-t border-slate-100 text-center text-xs text-slate-400 leading-relaxed">
        <p class="flex items-center justify-center gap-1 font-semibold text-slate-500 mb-1">
          <span>🔒</span> 全程加密传输 · 自动抵御撞库攻击
        </p>
        <p>如需开通权限或重置密码，请联系店主在店内端操作。</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { adminApi } from '../api/client.js';

const emit = defineEmits(['login-success']);

const username = ref('');
const password = ref('');
const showPassword = ref(false);
const isSubmitting = ref(false);
const errorMessage = ref('');

async function handleLogin() {
  if (!username.value.trim() || !password.value) return;
  errorMessage.value = '';
  isSubmitting.value = true;

  try {
    const data = await adminApi.login(username.value.trim(), password.value);
    emit('login-success', data);
  } catch (err) {
    errorMessage.value = err.message || '登录失败，请检查账号密码或网络连接';
  } finally {
    isSubmitting.value = false;
  }
}
</script>
