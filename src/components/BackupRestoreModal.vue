<template>
  <div
    v-if="request"
    class="feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fade-in"
    @click.self="emit('close')"
  >
    <section class="feedback-dialog modal-dialog w-full max-w-md bg-white rounded-3xl p-5 shadow-2xl text-left" role="alertdialog" aria-modal="true" aria-labelledby="restore-confirm-title">
      <div class="flex items-center space-x-3 pb-3 border-b border-slate-100">
        <span class="text-3xl">🛡️</span>
        <div>
          <h2 id="restore-confirm-title" class="text-xl font-black text-slate-900">备份文件恢复与智能对账</h2>
          <p class="text-xs text-slate-500 font-medium">检测并比对备份数据与手机当前数据</p>
        </div>
      </div>

      <!-- 文件与数据对比卡片 -->
      <div class="mt-3.5 space-y-2.5 text-xs">
        <div class="bg-slate-50 p-3 rounded-2xl border border-slate-200/80 space-y-1">
          <div class="flex justify-between text-slate-500">
            <span>备份文件名</span>
            <span class="font-bold text-slate-700 truncate max-w-[200px]">{{ request.fileName }}</span>
          </div>
          <div class="flex justify-between text-slate-500">
            <span>备份导出时间</span>
            <span class="font-bold text-slate-700">{{ formatTime(request.preview?.exportedAt) || '未知' }}</span>
          </div>
          <div class="flex justify-between text-slate-500">
            <span>备份内包含</span>
            <span class="font-black text-indigo-700">{{ request.preview?.backupStats?.memberCount || 0 }} 位会员 · {{ request.preview?.backupStats?.ledgerCount || 0 }} 笔流水 · ¥{{ formatCent(request.preview?.backupStats?.totalBalance || 0) }}</span>
          </div>
        </div>

        <!-- 当前手机系统数据对比 -->
        <div class="bg-indigo-50/60 p-3 rounded-2xl border border-indigo-100 flex justify-between items-center text-xs">
          <span class="text-indigo-950 font-bold">当前手机现有账本：</span>
          <span v-if="request.preview?.currentDataError" class="font-black text-rose-700">读取异常，无法统计</span>
          <span v-else class="font-black text-indigo-900">{{ request.preview?.currentStats?.memberCount || 0 }} 位会员 · {{ request.preview?.currentStats?.ledgerCount || 0 }} 笔流水</span>
        </div>

        <!-- 智能差异提示 -->
        <div v-if="request.preview?.diff?.hasNewerLocalData" class="p-3 bg-amber-50 border border-amber-200 rounded-2xl text-amber-900 font-bold space-y-1">
          <div class="flex items-center space-x-1.5 text-amber-800 font-black">
            <span>⚠️</span>
            <span>检测到当前手机有更新的开单记账！</span>
          </div>
          <p class="font-normal text-[11px] leading-relaxed text-amber-800">
            备份生成后，手机上又有新增开单或充值。使用增量合并时会核对账本延续关系，并保留已确认的更新交易。
          </p>
        </div>

        <!-- 对比明细统计 -->
        <div class="p-3 bg-slate-50 border border-slate-200/80 rounded-2xl text-slate-600 grid grid-cols-3 gap-2 text-center">
          <div>
            <div class="text-[11px] text-slate-400">新增会员</div>
            <div class="font-black text-sm text-emerald-600">+{{ request.preview?.diff?.newMembersCount || 0 }} 人</div>
          </div>
          <div>
            <div class="text-[11px] text-slate-400">补充历史流水</div>
            <div class="font-black text-sm text-emerald-600">+{{ request.preview?.diff?.newLedgersCount || 0 }} 笔</div>
          </div>
          <div>
            <div class="text-[11px] text-slate-400">跳过重复流水</div>
            <div class="font-black text-sm text-slate-500">{{ request.preview?.diff?.duplicateLedgersCount || 0 }} 笔</div>
          </div>
        </div>
      </div>

      <div v-if="request.preview?.mergeError" class="mt-3 p-3 rounded-2xl border border-rose-300 bg-rose-50 text-sm text-rose-900">
        <p class="font-black">此备份无法自动合并</p>
        <p class="mt-1">{{ request.preview.mergeError }}。请核对后选择完整账本进行全量恢复，当前原始数据会先保留。</p>
      </div>

      <!-- 恢复模式单选切换 -->
      <div class="mt-4 space-y-2">
        <div class="text-xs font-black text-slate-700">选择恢复方式：</div>
        
        <label 
          class="flex items-start p-3 rounded-2xl border-2 transition cursor-pointer"
          :class="currentMode === 'merge' ? 'border-emerald-500 bg-emerald-50/70 shadow-xs' : 'border-slate-200 bg-white'"
        >
          <input 
            type="radio" 
            value="merge" 
            v-model="currentMode" 
            :disabled="Boolean(request.preview?.mergeError)" 
            class="mt-1 mr-2.5 text-emerald-600" 
          />
          <div>
            <div class="font-black text-sm text-slate-900 flex items-center space-x-1.5">
              <span>🛡️ 智能增量合并</span>
              <span class="text-[10px] bg-emerald-600 text-white font-bold px-1.5 py-0.5 rounded">强烈推荐</span>
            </div>
            <div class="text-xs text-slate-500 mt-0.5 leading-relaxed">
              按会员与流水核对账本延续，同步更新余额及撤销状态。较旧备份保留当前交易；两边都有独立交易时停止合并。
            </div>
          </div>
        </label>

        <label 
          class="flex items-start p-3 rounded-2xl border-2 transition cursor-pointer"
          :class="currentMode === 'replace' ? 'border-rose-500 bg-rose-50/70 shadow-xs' : 'border-slate-200 bg-white'"
        >
          <input 
            type="radio" 
            value="replace" 
            v-model="currentMode" 
            class="mt-1 mr-2.5 text-rose-600" 
          />
          <div>
            <div class="font-black text-sm text-slate-900">⚠️ 全量恢复 (换机或修复损坏账本)</div>
            <div class="text-xs text-slate-500 mt-0.5 leading-relaxed">
              完全用备份文件替换当前手机的所有数据。若当前手机有比备份更新的消费，将被旧数据覆盖！
            </div>
          </div>
        </label>
      </div>

      <div class="mt-5 grid grid-cols-2 gap-3">
        <button 
          @click="emit('close')" 
          :disabled="isRestoring"
          class="h-13 rounded-2xl border-2 border-slate-300 text-sm font-bold text-slate-700 btn-press"
        >
          取消
        </button>
        <button 
          @click="emit('confirm')" 
          :disabled="isRestoring || !canWrite('importBackupData') || (currentMode === 'merge' && Boolean(request.preview?.mergeError))"
          class="h-13 rounded-2xl text-sm font-black text-white btn-press disabled:opacity-60 shadow-md shadow-emerald-600/20"
          :class="currentMode === 'merge' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'"
        >
          {{ isRestoring ? '正在安全恢复...' : (currentMode === 'merge' ? '确认增量合并' : '确认完全覆盖') }}
        </button>
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  request: { type: Object, default: null },
  modelValue: { type: String, default: 'merge' },
  isRestoring: Boolean,
  canWrite: { type: Function, default: () => true },
  formatTime: { type: Function, required: true },
  formatCent: { type: Function, required: true }
});

const emit = defineEmits(['close', 'confirm', 'update:modelValue']);

const currentMode = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
});
</script>