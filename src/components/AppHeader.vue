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
            <p class="text-xs text-slate-300 truncate max-w-44" :title="storeName">{{ storeName }}</p>
            <div class="header-meta text-indigo-300 font-semibold" :title="currentDateText + ' · ' + connectionLabel">
              <span class="header-meta-full">{{ currentDateText }} · {{ connectionLabel }}</span>
              <span class="header-meta-compact">{{ compactDateText }} · {{ compactConnectionLabel }}</span>
            </div>
          </div>
        </div>

        <!-- 登记按钮保留完整文字和字号，优先收缩品牌描述。 -->
        <button
          v-if="activeTab !== 'settings' && !cloudLocked"
          @click="emit('create-member')"
          :disabled="hasStorageError || !canCreateMember"
          class="register-member h-11 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 active:from-indigo-700 active:to-indigo-800 text-white text-sm rounded-2xl font-black shadow-md shadow-indigo-500/25 transition btn-press flex items-center"
        >
          <span class="text-base font-black">+</span>
          <span>登记会员</span>
        </button>
      </div>

      <!-- 紧凑搜索框，输入变化和失焦时立即查找。 -->
      <div v-if="activeTab !== 'settings' && !cloudLocked && !(activeTab === 'ledgers' && ledgerView === 'summary')" class="header-search relative">
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
          aria-label="搜索会员或手机号"
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
    </div>
  </header>
</template>

<script setup>
import { computed } from 'vue';
import { Search } from 'lucide-vue-next';

const props = defineProps({
  activeTab: { type: String, required: true },
  ledgerView: { type: String, default: 'transactions' },
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
  placeholder: { type: String, default: '' }
});

const emit = defineEmits(['open-account', 'create-member', 'search', 'clear-search', 'update:searchQuery']);

const searchModel = computed({
  get: () => props.searchQuery,
  set: (val) => emit('update:searchQuery', val)
});
</script>
