<template>
  <!-- 顶部状态栏与大搜索框 (适配水滴屏/挖孔屏，48px+ safe-area 防遮挡) -->
  <header class="app-header bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900/98 text-white pt-status-safe sticky top-0 z-30 shadow-lg border-b border-slate-800">
    <div class="header-inner">
      <!-- 标题行与新建按钮 -->
      <div class="header-row">
        <div class="header-brand">
          <span class="brand-icon" aria-hidden="true">💳</span>
          <div class="brand-copy">
            <h1 class="brand-title font-black text-white" aria-label="会员管家" title="会员管家">
              <span class="brand-full">会员管家</span>
              <span class="brand-medium">会员管家</span>
              <span class="brand-short">会员管家</span>
            </h1>
          </div>
        </div>

        <div v-if="!cloudLocked" class="header-actions">
          <button type="button" class="notice-entry" :class="{ 'has-notices': notices.length }"
            :aria-label="notices.length ? `提醒中心，${notices.length} 条待看提醒` : '提醒中心，暂无待看提醒'"
            :aria-current="activeTab === 'notices' ? 'page' : undefined" @click="emit('open-notices')">
            <Bell :size="21" aria-hidden="true" />
            <span v-if="notices.length" class="notice-count" aria-hidden="true">{{ notices.length > 99 ? '99+' : notices.length }}</span>
          </button>
          <button
            v-if="['customers', 'ledgers'].includes(activeTab) && !cloudLocked"
            @click="emit('create-member')"
            :disabled="hasStorageError || !canCreateMember"
            class="register-member h-11 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 active:from-indigo-700 active:to-indigo-800 text-white text-sm rounded-2xl font-black shadow-md shadow-indigo-500/25 transition btn-press flex items-center"
          >
            <span class="text-base font-black">+</span>
            <span>登记会员</span>
          </button>
        </div>
      </div>
      <div class="header-store-row">
        <p class="header-store-name" :title="storeName">{{ storeName }}</p>
      </div>
      <div class="header-meta" :title="currentDateText + ' · ' + connectionLabel">
        <span class="header-meta-full">{{ currentDateText }} · {{ connectionLabel }}</span>
        <span class="header-meta-compact">{{ compactDateText }} · {{ compactConnectionLabel }}</span>
      </div>

      <!-- 紧凑搜索框，输入变化和失焦时立即查找。 -->
      <div v-if="!cloudLocked && (activeTab === 'customers' || activeTab === 'ledgers' && ledgerView === 'transactions')" class="header-search-area">
        <div class="header-search-row">
          <div class="header-search relative">
            <input
              v-model="searchModel"
              @input="emit('search', $event)"
              @change="emit('search', $event)"
              @blur="emit('search', $event)"
              @compositionend="emit('search', $event)"
              type="text"
              :placeholder="placeholder"
              maxlength="64"
              class="header-search-input pl-10 pr-10 text-base"
              :aria-label="activeTab === 'ledgers' ? '搜索交易明细' : '搜索会员或手机号'"
              aria-describedby="header-search-hint"
            />
            <Search :size="21" class="absolute left-3 top-3 text-slate-500 pointer-events-none" aria-hidden="true" />
            <button
              v-if="searchModel"
              @click="emit('clear-search')"
              class="absolute right-2 top-2 text-slate-300 hover:text-white text-base w-8 h-8 flex items-center justify-center rounded-full bg-slate-700 active:bg-slate-600"
              aria-label="清空搜索"
            >
              ✕
            </button>
          </div>
          <CustomerFilter v-if="activeTab === 'customers'" :filter="customerFilter" :open="filterOpen"
            @update:filter="emit('update:customerFilter', $event)" @update:open="emit('update:filterOpen', $event)" />
        </div>
        <p id="header-search-hint" class="header-search-hint">{{ searchHint }}</p>
      </div>
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { Bell, Search } from 'lucide-vue-next';
import CustomerFilter from './CustomerFilter.vue';

const props = defineProps({
  activeTab: { type: String, required: true },
  customerFilter: { type: String, default: 'recent' },
  filterOpen: Boolean,
  notices: { type: Array, default: () => [] },
  ledgerView: { type: String, default: 'summary' },
  cloudLocked: Boolean,
  storeName: { type: String, default: '我的门店' },
  cloudBinding: Boolean,
  cloudOnline: Boolean,
  outboxLength: { type: Number, default: 0 },
  hasStorageError: Boolean,
  canCreateMember: Boolean,
  connectionLabel: { type: String, default: '' },
  compactConnectionLabel: { type: String, default: '' },
  currentDateText: { type: String, default: '' },
  compactDateText: { type: String, default: '' },
  searchQuery: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  searchHint: { type: String, default: '' }
});

const emit = defineEmits(['open-account', 'open-notices', 'create-member', 'search', 'clear-search', 'update:searchQuery', 'update:customerFilter', 'update:filterOpen']);

const searchModel = computed({
  get: () => props.searchQuery,
  set: (val) => emit('update:searchQuery', val)
});
</script>
