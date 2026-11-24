<template>
  <!-- 顶部状态栏与大搜索框 (适配水滴屏/挖孔屏，48px+ safe-area 防遮挡) -->
  <header class="app-header bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900/98 text-white pt-status-safe sticky top-0 z-30 shadow-md border-b border-slate-800">
    <div class="header-inner max-w-4xl mx-auto px-3.5 py-2.5 sm:px-6">
      <!-- 标题行与新建按钮 -->
      <div class="header-row flex items-center justify-between gap-2.5">
        <div class="header-brand flex items-center gap-2.5 min-w-0 flex-1">
          <span class="brand-icon w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center font-black text-lg shadow-md shrink-0" aria-hidden="true">💳</span>
          <div class="brand-copy min-w-0">
            <h1 class="brand-title text-base font-black text-white tracking-tight m-0 truncate leading-tight" aria-label="会员管家" title="会员管家">
              会员管家
            </h1>
            <p class="header-meta m-0 text-xs text-slate-300 font-medium flex items-center gap-1.5 mt-0.5 truncate">
              <span class="w-2 h-2 rounded-full shrink-0" :class="cloudOnline ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'"></span>
              <span class="truncate">{{ storeName }} · {{ connectionLabel || (cloudOnline ? '云端已连接' : '本机离线') }}</span>
            </p>
          </div>
        </div>

        <div v-if="!cloudLocked" class="header-actions flex items-center gap-2 shrink-0">
          <button
            type="button"
            class="notice-entry relative w-9 h-9 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center border border-slate-700 btn-press shrink-0"
            :class="{ 'has-notices': notices.length }"
            :aria-label="notices.length ? `提醒中心，${notices.length} 条待看提醒` : '提醒中心，暂无待看提醒'"
            :aria-current="activeTab === 'notices' ? 'page' : undefined"
            @click="emit('open-notices')"
          >
            <Bell :size="18" aria-hidden="true" />
            <span v-if="notices.length" class="notice-count absolute -top-1 -right-1 px-1.5 py-0.2 bg-rose-600 text-white text-[10px] font-black rounded-full shadow-xs" aria-hidden="true">
              {{ notices.length > 99 ? '99+' : notices.length }}
            </span>
          </button>
          <button
            v-if="['customers', 'members'].includes(activeTab) && !cloudLocked"
            type="button"
            @click="emit('create-member')"
            :disabled="hasStorageError || !canCreateMember"
            class="register-member h-9 px-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 active:from-emerald-700 text-white text-xs font-black rounded-xl shadow-md shadow-emerald-950/40 flex items-center gap-1 btn-press transition-all shrink-0"
            aria-label="新增会员"
          >
            <span class="text-sm font-black leading-none">+</span>
            <span>登记会员</span>
          </button>
        </div>
      </div>

      <!-- 紧凑搜索框与聚合筛选下拉 (仅在会员或流水交易时显示) -->
      <div v-if="!cloudLocked && (['customers', 'members'].includes(activeTab) || ['ledgers', 'ledger'].includes(activeTab) && ledgerView === 'transactions')" class="header-search-area mt-2.5">
        <div class="header-search-row flex items-center gap-2">
          <div class="header-search relative flex-1 min-w-0">
            <span class="sr-only">搜索会员</span>
            <input
              v-model="searchModel"
              @input="emit('search', $event)"
              @change="emit('search', $event)"
              @blur="emit('search', $event)"
              type="text"
              :placeholder="placeholder || '搜索会员或手机号'"
              maxlength="64"
              class="header-search-input pl-10 pr-9 text-sm w-full h-10 bg-slate-800/90 border border-slate-700/80 rounded-xl text-white placeholder-slate-400 font-medium focus:bg-slate-800 focus:border-emerald-500 outline-none"
              :aria-label="['ledgers', 'ledger'].includes(activeTab) ? '搜索交易明细' : '搜索会员'"
              aria-describedby="header-search-hint"
            />
            <Search :size="17" class="absolute left-3 top-3 text-slate-400 pointer-events-none" aria-hidden="true" />
            <button
              v-if="searchModel"
              type="button"
              @click="emit('clear-search')"
              class="absolute right-2 top-2 text-slate-400 hover:text-white text-xs w-6 h-6 flex items-center justify-center rounded-full bg-slate-700 active:bg-slate-600"
              aria-label="清空搜索"
            >
              ✕
            </button>
          </div>
          <CustomerFilter
            v-if="['customers', 'members'].includes(activeTab)"
            :filter="customerFilter"
            :open="filterOpen"
            @update:filter="emit('update:customerFilter', $event)"
            @update:open="emit('update:filterOpen', $event)"
          />
        </div>
        <p v-if="searchHint" id="header-search-hint" class="header-search-hint text-[11px] text-slate-400 mt-1">{{ searchHint }}</p>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { Bell, Search } from 'lucide-vue-next';
import CustomerFilter from './CustomerFilter.vue';

const props = defineProps({
  activeTab: { type: String, default: 'members' },
  customerFilter: { type: String, default: 'all' },
  filterOpen: Boolean,
  notices: { type: Array, default: () => [] },
  ledgerView: { type: String, default: 'summary' },
  cloudLocked: Boolean,
  storeName: { type: String, default: '会员管家' },
  cloudBinding: Boolean,
  cloudOnline: Boolean,
  hasStorageError: Boolean,
  canCreateMember: { type: Boolean, default: true },
  connectionLabel: { type: String, default: '' },
  currentDateText: { type: String, default: '' },
  searchQuery: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  searchHint: { type: String, default: '' }
});

const emit = defineEmits([
  'open-account',
  'open-notices',
  'create-member',
  'search',
  'clear-search',
  'update:searchQuery',
  'update:customerFilter',
  'update:filterOpen'
]);

const searchModel = computed({
  get: () => props.searchQuery,
  set: (val) => emit('update:searchQuery', val)
});
</script>
