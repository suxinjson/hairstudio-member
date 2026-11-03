<template>
  <div class="app-shell flex flex-col min-h-screen bg-slate-100/90 text-slate-900 select-none pb-28" @contextmenu="handleContextMenu" @pointerdown="resetExitSequence">
    
    <!-- 顶部状态栏与大搜索框 (适配水滴屏/挖孔屏，48px+ safe-area 防遮挡) -->
    <header class="app-header bg-gradient-to-b from-slate-950 via-slate-900 to-slate-900/98 text-white pt-status-safe sticky top-0 z-30 shadow-lg border-b border-slate-800">
      <div class="header-inner">
        <!-- 标题行与新建按钮 -->
        <div class="header-row">
          <div class="header-brand">
            <span class="brand-icon" aria-hidden="true">💈</span>
            <div class="brand-copy">
              <h1 class="brand-title font-black text-white" aria-label="梦飞空间会员管家" title="梦飞空间会员管家">
                <span class="brand-full">梦飞空间会员管家</span>
                <span class="brand-medium">梦飞会员管家</span>
                <span class="brand-short">梦飞会员</span>
              </h1>
              <div class="header-meta text-indigo-300 font-semibold" :title="currentDateText + ' · ' + connectionLabel">
                <span class="header-meta-full">{{ currentDateText }} · {{ connectionLabel }}</span>
                <span class="header-meta-compact">{{ compactDateText }} · {{ compactConnectionLabel }}</span>
              </div>
            </div>
          </div>

          <!-- 登记按钮保留完整文字和字号，优先收缩品牌描述。 -->
          <button 
            v-if="activeTab !== 'settings' && !cloudLocked"
            @click="openNewMemberModal"
            :disabled="Boolean(storageError) || !canCloudWrite('createMember')"
            class="register-member h-11 bg-gradient-to-r from-indigo-500 to-indigo-600 hover:from-indigo-600 hover:to-indigo-700 active:from-indigo-700 active:to-indigo-800 text-white text-sm rounded-2xl font-black shadow-md shadow-indigo-500/25 transition btn-press flex items-center"
          >
            <span class="text-base font-black">+</span>
            <span>新客户</span>
          </button>
        </div>

        <!-- 紧凑搜索框，输入变化和失焦时立即查找。 -->
        <div v-if="activeTab !== 'settings' && !cloudLocked && !(activeTab === 'ledgers' && ledgerView === 'summary')" class="header-search relative">
          <input 
            v-model="headerSearchQuery"
            @change="handleSearch"
            @blur="handleSearch"
            @compositionend="handleSearch"
            type="text" 
            :placeholder="searchPlaceholder"
            class="w-full bg-slate-800/90 border-2 border-slate-700/90 text-white text-base rounded-2xl pl-10 pr-10 placeholder:text-slate-400 focus:outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/20 transition shadow-inner font-bold"
          />
          <Search :size="21" class="absolute left-3 top-3 text-slate-500 pointer-events-none" aria-hidden="true" />
          <button 
            v-if="headerSearchQuery"
            @click="clearSearch"
            class="absolute right-2 top-2 text-slate-300 hover:text-white text-base w-8 h-8 flex items-center justify-center rounded-full bg-slate-700 active:bg-slate-600"
          >
            ✕
          </button>
        </div>
      </div>
    </header>

    <!-- 主视口内容 -->
    <main class="app-content flex-1 p-3.5 space-y-4">
      <div v-if="cloudState.binding && !cloudLocked && (cloudState.outbox.length || cloudState.status === 'conflict' || !cloudState.online)" class="sync-banner rounded-2xl p-3 border bg-white text-sm flex items-center justify-between gap-2">
        <span>{{ cloudState.online ? '☁️ 已联网' : '📴 当前离线' }}<span v-if="cloudState.outbox.length"> · 待同步 {{ cloudState.outbox.length }} 笔</span><span v-if="cloudState.status === 'conflict'"> · 请核对冲突</span></span>
        <button @click="openSettings('account')" class="font-bold text-indigo-700">同步设置</button>
      </div>
      <div v-if="storageError" class="p-4 rounded-2xl bg-rose-50 border-2 border-rose-300 text-rose-900">
        <p class="font-black">当前账本无法读取，请从有效备份恢复。</p>
        <p class="text-sm mt-2">{{ storageError }}。恢复前会保留当前原始数据。</p>
        <button @click="openSettings('backup-files')" class="mt-3 font-black underline">打开备份恢复</button>
      </div>
      
      <!-- 统一客户入口：快速扣款与客户档案共享一份列表。 -->
      <Customers v-if="activeTab === 'customers' && !cloudLocked"
        v-model:filter="customerFilter" :members="membersList" :ledgers="customerLedgers"
        :query="searchQuery" :summary="dashboard"
        :can-consume="!storageError && canCloudWrite('consume')"
        :can-create="!storageError && canCloudWrite('createMember')"
        @select="selectMember" @consume="openConsumeModal" @create="openNewMemberModal" />

      <!-- ==================== TAB 3: 流水明细与撤销冲正 ==================== -->
      <div v-if="activeTab === 'ledgers' && !cloudLocked" class="space-y-3.5">
        <div class="ledger-tabs" role="tablist" aria-label="账单流水视图">
          <button id="ledger-transactions-tab" role="tab" :aria-selected="ledgerView === 'transactions'" aria-controls="ledger-transactions" @click="ledgerView = 'transactions'">流水明细</button>
          <button id="ledger-summary-tab" role="tab" :aria-selected="ledgerView === 'summary'" aria-controls="ledger-summary" @click="ledgerView = 'summary'">收银简报</button>
        </div>
        <div v-if="ledgerView === 'transactions'" id="ledger-transactions" role="tabpanel" aria-labelledby="ledger-transactions-tab" class="space-y-3.5">
          <!-- 筛选标签 -->
          <div class="flex space-x-1.5 bg-slate-200/80 p-1.5 rounded-2xl text-sm font-black">
            <button
              v-for="type in [{ key: '', label: '全部流水' }, { key: 'CONSUME', label: '剪发扣费' }, { key: 'RECHARGE', label: '储值入账' }, { key: 'REFUND', label: '撤销记录' }]"
              :key="type.key"
              @click="ledgerFilterType = type.key; refreshLedgers()"
              class="flex-1 py-2.5 rounded-xl transition text-center btn-press"
              :class="ledgerFilterType === type.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'"
            >
              {{ type.label }}
            </button>
          </div>

          <div v-if="filteredLedgersList.length === 0" class="bg-white rounded-3xl p-8 text-center border border-slate-200/90 text-slate-500 text-base font-bold">
            {{ ledgerSearchQuery ? '没有找到匹配的流水，请换个姓名、手机号或关键词试试' : '暂无相关账目流水' }}
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="item in filteredLedgersList"
              :key="item.id"
              class="bg-white p-4.5 rounded-3xl border border-slate-200/90 shadow-[0_2px_8px_rgba(0,0,0,0.03)] text-sm"
            >
              <div class="flex items-center justify-between">
                <div class="flex items-center space-x-2">
                  <span
                    class="px-2.5 py-1 rounded-xl font-black text-xs"
                    :class="getBadgeClass(item.type)"
                  >
                    {{ getTypeText(item.type) }}
                  </span>
                  <button class="copyable-text font-black text-slate-900 text-lg" @click.stop="copyMemberField(item.memberName, '姓名')" aria-label="复制会员姓名">{{ item.memberName }}</button>
                  <button class="copyable-text text-slate-500 font-mono font-bold" @click.stop="copyMemberField(item.memberPhone, '手机号')" aria-label="复制会员手机号">{{ formatPhoneSpaced(item.memberPhone) }}</button>
                </div>
                <div
                  class="text-lg font-black tabular-nums"
                  :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
                >
                  {{ item.changeAmount > 0 ? '+' : '' }}{{ (item.changeAmount / 100).toFixed(2) }} 元
                </div>
              </div>

              <div class="mt-3 flex items-center justify-between text-slate-600 pt-2.5 border-t border-slate-100 text-xs font-semibold">
                <div class="truncate max-w-[220px]">
                  {{ item.remark || '无项目说明' }}
                </div>
                <div>
                  {{ item.balanceAfter < 0 ? '变动后欠款' : '变动后余额' }}: <strong class="text-slate-900 font-black" :class="{ 'balance-debt': item.balanceAfter < 0 }">¥{{ formatCent(Math.abs(item.balanceAfter)) }}</strong>
                </div>
              </div>

              <!-- 时间与撤单操作 -->
              <div class="flex items-center justify-between text-slate-400 text-xs mt-2.5 pt-1.5 border-t border-dashed border-slate-100">
                <span class="font-medium">{{ formatTime(item.created_at) }}</span>

                <button
                  v-if="item.type !== 'REFUND' && !item.isRefunded"
                  @click.stop="confirmRefundLedger(item)"
                  :disabled="!canCloudWrite('refundLedger')"
                  class="text-rose-600 hover:text-rose-700 bg-rose-50 border border-rose-200/80 px-3.5 py-1.5 rounded-xl font-bold active:bg-rose-100 text-xs btn-press"
                >
                  撤销此单
                </button>
                <span v-else-if="item.isRefunded" class="text-slate-400 bg-slate-100 px-2.5 py-1 rounded-xl font-medium">
                  已撤销冲正
                </span>
              </div>
            </div>
          </div>
        </div>
        <div v-else id="ledger-summary" role="tabpanel" aria-labelledby="ledger-summary-tab">
          <!-- 今日营业收支卡片 (高档清爽配色，清晰大字) -->
          <div class="dashboard-card bg-white rounded-3xl p-4.5 shadow-[0_2px_12px_rgba(0,0,0,0.04)] border border-slate-200/90">
            <div class="flex items-center justify-between pb-3 border-b border-slate-100">
              <span class="text-sm font-black text-slate-800 flex items-center space-x-2">
                <span class="text-base">📊</span>
                <span>今日小店收银简报</span>
              </span>
              <span class="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full font-bold">
                ✓ {{ isNativeApp && !cloudState.binding ? '数据保存在本机' : '账本状态正常' }}
              </span>
            </div>

            <div class="grid grid-cols-2 gap-3 mt-3.5">
              <div class="bg-gradient-to-br from-emerald-50/80 to-teal-50/40 p-4 rounded-2xl border border-emerald-100">
                <div class="text-xs text-emerald-800 font-bold">今日储值充值</div>
                <div class="text-2xl font-black text-emerald-600 tabular-nums mt-1">
                  ¥ {{ formatCent(dashboard.today?.rechargeCreditTotal || 0) }}
                </div>
                <div class="text-xs text-emerald-700 font-medium mt-1">
                  入账 {{ dashboard.today?.rechargeCount || 0 }} 笔
                </div>
              </div>

              <div class="bg-gradient-to-br from-rose-50/80 to-orange-50/40 p-4 rounded-2xl border border-rose-100">
                <div class="text-xs text-rose-800 font-bold">今日剪发扣额</div>
                <div class="text-2xl font-black text-rose-600 tabular-nums mt-1">
                  ¥ {{ formatCent(dashboard.today?.consumeAmount || 0) }}
                </div>
                <div class="text-xs text-rose-700 font-medium mt-1">
                  到店服务 {{ dashboard.today?.consumeCount || 0 }} 人次
                </div>
              </div>
            </div>

            <div class="mt-3.5 pt-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-semibold">
              <div>
                客户储值余额：<strong class="text-slate-900 text-sm font-black tabular-nums">¥ {{ formatCent(dashboard.totalCreditBalance || 0) }}</strong>
              </div>
              <div v-if="dashboard.totalDebt" class="debt-dashboard-line">客户待收欠款：<strong>¥ {{ formatCent(dashboard.totalDebt) }}</strong> · {{ dashboard.debtMemberCount }} 人</div>
              <div>
                总客户数：<strong class="text-slate-900 text-sm font-black">{{ dashboard.memberCount || 0 }}</strong> 人
              </div>
            </div>
          </div>

        </div>
      </div>

      <!-- ==================== TAB 4: 服务定价与备份安全 ==================== -->
      <div v-if="activeTab === 'settings'" class="space-y-4">
        <div v-if="!cloudLocked && settingsPath.length" class="settings-page-heading">
          <button @click="backInSettings" class="settings-back" aria-label="返回上一级设置">‹ {{ settingsPath.length > 1 ? '返回数据备份' : '返回设置' }}</button>
          <h2 class="font-black text-xl">{{ settingsTitles[settingsPage] }}</h2>
        </div>
        <CloudSettings v-if="cloudLocked || ['account', 'users', 'activity', 'update'].includes(settingsPage)"
          :section="cloudLocked ? 'account' : settingsPage" :show-title="cloudLocked" :recovery-required="Boolean(storageError)" @navigate="openSettings" />
        <template v-if="!cloudLocked">
        <template v-if="settingsPage === 'overview'">
          <section class="settings-summary bg-white border border-slate-200 rounded-2xl p-5">
            <div class="flex items-center justify-between gap-3">
              <h2 class="font-black text-xl">设置</h2>
              <span class="settings-status">{{ cloudState.user ? (cloudState.online && !cloudState.syncLoginRequired ? '云端已登录' : '离线可用') : '本机模式' }}</span>
            </div>
            <p class="text-sm text-slate-500 mt-2">{{ cloudState.user ? cloudState.user.displayName + ' · ' + (cloudState.binding ? '账本已保存在本机，联网自动同步' : '可继续使用本机账本') : '无需登录也能使用本机账本' }}</p>
            <p v-if="cloudState.binding" class="text-sm text-slate-600 mt-2">待同步 {{ cloudState.outbox.length }} 笔<span v-if="cloudState.syncLoginRequired"> · 同步前需登录原账号</span></p>
          </section>
          <section v-for="group in settingsGroups" :key="group.title" class="settings-category">
            <h3 class="text-sm font-bold text-slate-500 mb-2">{{ group.title }}</h3>
            <div class="settings-menu bg-white border border-slate-200 rounded-2xl">
              <button v-for="entry in group.items" :key="entry.page" @click="openSettings(entry.page)" class="settings-menu-item">
                <span class="settings-entry-icon" aria-hidden="true">{{ entry.icon }}</span>
                <span class="settings-entry-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span>
                <span class="settings-chevron" aria-hidden="true">›</span>
              </button>
            </div>
          </section>
        </template>
        <section v-if="settingsPage === 'backup'" class="settings-menu bg-white border border-slate-200 rounded-2xl">
          <button v-for="entry in backupEntries" :key="entry.page" @click="openSettingsPage(entry.page)" class="settings-menu-item">
            <span class="settings-entry-icon" aria-hidden="true">{{ entry.icon }}</span>
            <span class="settings-entry-copy"><strong>{{ entry.title }}</strong><small>{{ entry.description }}</small></span>
            <span class="settings-chevron" aria-hidden="true">›</span>
          </button>
        </section>
        
        <!-- 理发项目与定价管理 -->
        <div v-if="settingsPage === 'services'" class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
          <div class="flex items-center justify-between pb-3.5 border-b border-slate-100">
            <div>
              <h2 class="font-black text-slate-900 text-lg">💈 服务项目与定价设置</h2>
              <p class="text-xs text-slate-400 font-medium mt-0.5">收银扣款时可一键带入常用项目与金额</p>
            </div>
            <button 
              @click="openAddServiceModal"
              :disabled="!canCloudWrite('saveService')"
              class="h-11 bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-4 rounded-xl font-black shadow-sm btn-press"
            >
              + 新增项目
            </button>
          </div>

          <div class="divide-y divide-slate-100 mt-1">
            <div 
              v-for="s in hairServices" 
              :key="s.id"
              class="py-3.5 flex items-center justify-between text-sm"
            >
              <div>
                <span class="font-black text-slate-900 text-base">{{ s.name }}</span>
                <span class="text-indigo-600 font-black ml-2.5 text-base">¥ {{ s.price }}</span>
              </div>
              <div class="flex space-x-2">
                <button 
                  @click="openEditServiceModal(s)"
                  :disabled="!canCloudWrite('saveService')"
                  class="h-9 px-3.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl font-bold text-xs active:bg-indigo-100 btn-press"
                >
                  修改
                </button>
                <button 
                  @click="deleteServiceItem(s.id)"
                  :disabled="!canCloudWrite('deleteService')"
                  class="h-9 px-3.5 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl font-bold text-xs active:bg-rose-100 btn-press"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 微信安全备份中心 -->
        <div v-if="settingsPage === 'backup-files'" class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
          <div class="flex items-center space-x-3 mb-2">
            <span class="text-3xl">🛡️</span>
            <div>
              <h2 class="font-black text-slate-900 text-lg">单机账本安全与微信备份</h2>
              <p class="text-xs text-slate-400 font-medium">数据存放在手机安全沙盒，微信备份双重保险</p>
            </div>
          </div>

          <div class="space-y-3 mt-4">
            <!-- 导出备份发到微信 -->
            <button 
              @click="handleExportBackup"
              :disabled="isExporting"
              class="w-full h-18 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white px-4.5 rounded-2xl font-black text-sm flex items-center justify-between shadow-md shadow-emerald-600/20 btn-press"
            >
              <div class="flex items-center space-x-3">
                <span class="text-2xl">📤</span>
                <div class="text-left">
                  <div class="text-base font-black">{{ storageError ? '导出账本原始数据' : '一键备份所有账本 (发送至微信)' }}</div>
                  <div class="text-xs text-emerald-100 font-medium">{{ storageError ? '保留当前数据，再从有效备份恢复' : '生成全店备份文件，发给微信“文件传输助手”保存' }}</div>
                </div>
              </div>
              <span class="text-xl">›</span>
            </button>

            <!-- 导出 Excel 表格 -->
            <button 
              @click="handleExportCSV"
              :disabled="isExporting || Boolean(storageError)"
              class="w-full h-18 bg-gradient-to-r from-blue-600 to-indigo-700 hover:from-blue-700 hover:to-indigo-800 text-white px-4.5 rounded-2xl font-black text-sm flex items-center justify-between shadow-md shadow-blue-500/20 btn-press"
            >
              <div class="flex items-center space-x-3">
                <span class="text-2xl">📊</span>
                <div class="text-left">
                  <div class="text-base font-black">导出 Excel 对账明细表 (.csv)</div>
                  <div class="text-xs text-blue-100 font-medium">手机 WPS 或电脑直接打开核算对账</div>
                </div>
              </div>
              <span class="text-xl">›</span>
            </button>

            <!-- 恢复备份 -->
            <div class="pt-2">
              <label class="w-full h-18 bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-800 px-4.5 rounded-2xl font-black text-sm flex items-center justify-between border-2 border-slate-200 cursor-pointer">
                <div class="flex items-center space-x-3">
                  <span class="text-2xl">📥</span>
                  <div class="text-left">
                    <div class="text-base font-black text-slate-900">从微信备份文件恢复数据</div>
                    <div class="text-xs text-slate-500 font-medium">换新手机或误删时，选中备份文件一秒瞬间还原</div>
                  </div>
                </div>
                <span class="text-indigo-600 font-extrabold text-xs bg-indigo-50 border border-indigo-200 px-3 py-1.5 rounded-xl">选择文件</span>
                <input type="file" accept=".json" @change="handleImportBackup" class="hidden" />
              </label>
            </div>
          </div>
        </div>

        <!-- 仅 App 展示安卓文件说明，网页无需暴露设备路径信息 -->
        <div v-if="isNativeApp && settingsPage === 'file-guide'" class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)] space-y-3">
          <div class="flex items-center space-x-2.5">
            <span class="text-2xl">📁</span>
            <div>
              <h3 class="font-black text-slate-900 text-base">导出文件默认保存路径</h3>
              <p class="text-xs text-slate-400 font-medium">可在手机文件管理器中查找备份与Excel表格</p>
            </div>
          </div>

          <div class="space-y-2 text-xs">
            <div class="p-3 bg-slate-50 rounded-2xl border border-slate-200/90 flex items-start space-x-2.5">
              <span class="text-base">📱</span>
              <div class="flex-1">
                <div class="font-bold text-slate-800">安卓文件保存方式：</div>
                <div class="text-indigo-700 font-bold mt-0.5">系统分享面板 → 文件管理器或微信</div>
                <div class="text-[11px] text-slate-500 mt-0.5">导出后选择接收应用，并确认文件可打开。浏览器版请查看浏览器下载记录。</div>
              </div>
            </div>

            <div class="p-3 bg-emerald-50/70 rounded-2xl border border-emerald-200/90 flex items-start space-x-2.5">
              <span class="text-base">💬</span>
              <div class="flex-1">
                <div class="font-bold text-emerald-950">微信文件传输助手保存：</div>
                <div class="font-mono text-emerald-800 font-bold mt-0.5">微信聊天记录 > 文件传输助手</div>
                <div class="text-[11px] text-emerald-800 mt-0.5">请将接收到的文件另存，并定期确认可打开。换新手机时，选择保存的 JSON 文件恢复。</div>
              </div>
            </div>
          </div>
        </div>

        <!-- App内检测到的备份文件与本地快照列表 -->
        <div v-if="settingsPage === 'snapshots'" class="bg-white rounded-3xl p-5 border border-slate-200/90 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
          <div class="flex items-center justify-between pb-3.5 border-b border-slate-100">
            <div class="flex items-center space-x-2.5">
              <span class="text-2xl">📑</span>
              <div>
                <h3 class="font-black text-slate-900 text-base">App检测到的本地备份 (共 {{ localSnapshots.length }} 份)</h3>
                <p class="text-xs text-slate-400 font-medium">手机专属沙盒内安全快照，点击可直接恢复</p>
              </div>
            </div>
            <button 
              @click="handleCreateManualSnapshot"
              class="h-9 px-3 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs font-bold rounded-xl btn-press"
            >
              + 立即归档
            </button>
          </div>

          <div v-if="localSnapshots.length === 0" class="py-8 text-center text-xs text-slate-400 font-bold">
            暂无历史快照，点击上方「一键备份所有账本」可自动生成并归档
          </div>
          <div v-else class="space-y-3 mt-3.5">
            <div 
              v-for="s in localSnapshots" 
              :key="s.id" 
              class="p-4 bg-slate-50/90 rounded-2xl border border-slate-200/90 text-xs space-y-2.5"
            >
              <div class="flex items-center justify-between">
                <span class="font-black text-slate-900 text-sm truncate max-w-[210px]">{{ s.fileName }}</span>
                <span class="text-[11px] bg-indigo-100 text-indigo-900 font-bold px-2 py-0.5 rounded-lg">{{ s.tag }}</span>
              </div>
              <div class="flex items-center justify-between text-slate-600 font-medium">
                <span>{{ formatTime(s.createdAt) }}</span>
                <span>包含 {{ s.memberCount }} 客户 · {{ s.ledgerCount }} 笔流水 · 净余额 ¥{{ formatCent(s.totalBalance) }}</span>
              </div>
              <div class="flex space-x-2 pt-2 border-t border-slate-200/70">
                <button 
                  @click="handleRestoreSnapshot(s, 'merge')" 
                  class="flex-1 h-9 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold rounded-xl btn-press shadow-xs"
                >
                  🛡️ 智能合并恢复 (推荐)
                </button>
                <button 
                  @click="handleShareSnapshot(s)" 
                  :disabled="isExporting"
                  class="h-9 px-3.5 bg-slate-200 hover:bg-slate-300 active:bg-slate-400 text-slate-800 font-bold rounded-xl btn-press"
                >
                  📤 分享
                </button>
                <button 
                  @click="handleDeleteSnapshot(s.id)" 
                  class="h-9 px-3 text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 font-bold rounded-xl btn-press"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 理发店省心锦囊 -->
        <div v-if="settingsPage === 'help'" class="bg-indigo-50 border border-indigo-100 p-4.5 rounded-3xl text-xs text-indigo-950 space-y-2 leading-relaxed">
          <div class="font-black text-sm flex items-center space-x-1.5">
            <span>💡</span>
            <span>理发店安心记账小贴士：</span>
          </div>
          <p>1. 本机账本支持离线记账，登录并绑定云端后联网自动同步。卸载或清除应用数据前请先导出备份。</p>
          <p>2. 建议每天打烊时确认待同步记录为零，并另存一份 JSON 备份，定期核对文件可打开。</p>
          <p>3. 点击会员姓名或手机号旁的复制标记即可复制；输入框可长按粘贴，普通页面文字不弹出选择菜单。</p>
          <p>4. 返回键先关闭弹窗或返回上一层，在主页面连续按三次返回退出应用。</p>
        </div>
        </template>
      </div>

    </main>

    <!-- 三个主入口，统一客户列表与收银操作。 -->
    <nav v-if="!cloudLocked" class="app-nav fixed bottom-0 left-0 right-0 mx-auto bg-white/95 backdrop-blur-md z-30 pb-gesture-safe" aria-label="主导航">
      <div class="grid grid-cols-3 h-16">
        <button @click="activeTab = 'customers'" :aria-current="activeTab === 'customers' ? 'page' : undefined" :class="{ 'nav-active': activeTab === 'customers' }" class="app-nav-item btn-press">
          <UsersRound :size="23" aria-hidden="true" /><span>客户</span>
        </button>
        <button @click="activeTab = 'ledgers'" :aria-current="activeTab === 'ledgers' ? 'page' : undefined" :class="{ 'nav-active': activeTab === 'ledgers' }" class="app-nav-item btn-press">
          <ReceiptText :size="23" aria-hidden="true" /><span>流水</span>
        </button>
        <button @click="openSettings()" :aria-current="activeTab === 'settings' ? 'page' : undefined" :class="{ 'nav-active': activeTab === 'settings' }" class="app-nav-item btn-press">
          <Settings :size="23" aria-hidden="true" /><span>设置</span>
        </button>
      </div>
    </nav>

    <!-- ==================== 弹窗与抽屉层 ==================== -->

    <!-- 1. 剪发消费扣款抽屉 (核心大按键收银台) -->
    <div 
      v-if="consumingMember" 
      class="fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs"
      @click.self="handleConsumeModalBack"
    >
      <div class="consume-sheet bg-white rounded-t-[32px] max-h-[92vh] flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full overflow-hidden" :class="{ 'consume-sheet-debt': isConsumeOverBalance }">
        <!-- 弹窗把手 (固定顶部) -->
        <div class="pt-2.5 pb-1 flex-shrink-0">
          <div class="w-12 h-1.5 bg-slate-300 rounded-full mx-auto"></div>
        </div>

        <!-- 弹窗顶栏 (固定顶部) -->
        <div class="modal-header px-5 py-2.5 border-b border-slate-100 flex items-center justify-between flex-shrink-0">
          <div class="modal-header-copy">
            <div class="modal-title font-black text-xl text-slate-900 flex items-center space-x-2">
              <span>✂️ 剪发扣款</span>
              <span class="text-indigo-600 truncate max-w-[170px]">— {{ consumingMember.name }}</span>
            </div>
            <div class="text-sm text-slate-500 font-semibold mt-0.5">
              {{ consumingMember.balance < 0 ? '当前欠款' : '可用余额' }}：<strong class="text-indigo-600 text-lg font-black tabular-nums" :class="{ 'balance-debt': consumingMember.balance < 0 }">¥ {{ formatCent(Math.abs(consumingMember.balance)) }}</strong>
            </div>
          </div>
          <button 
            @click="closeConsumeModal" 
            class="w-10 h-10 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xl font-bold active:bg-slate-200 btn-press"
          >
            ✕
          </button>
        </div>

        <!-- 顾客发型习惯便签 -->
        <div v-if="consumingMember.notes" class="px-5 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-900 font-bold flex items-center space-x-1.5 flex-shrink-0">
          <span>💇 发型偏好：</span>
          <span class="truncate">{{ consumingMember.notes }}</span>
        </div>

        <!-- ===== 中间可滚动区域 (包含金额卡片、服务快捷选择、备注输入) ===== -->
        <div class="flex-1 overflow-y-auto p-4 space-y-3.5 min-h-0">
          <!-- 金额展示卡片 (点击调出键盘，支持直接修改金额，高亮焦点态) -->
          <div 
            @click="openConsumeKeypad"
            class="p-4 rounded-2xl border-2 transition-all cursor-pointer select-none"
            :class="isConsumeOverBalance ? 'consume-amount-debt' : showConsumeKeypad ? 'border-indigo-500/70 bg-indigo-50/40 shadow-sm ring-2 ring-indigo-200/50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100/70'"
          >
            <div class="flex items-center justify-between">
              <div class="text-xs font-black uppercase tracking-wider" :class="showConsumeKeypad ? 'text-indigo-600' : 'text-slate-500'">
                本次扣款金额 (元)
              </div>
              <div class="flex items-center space-x-2">
                <span v-if="showConsumeKeypad" class="text-xs font-bold text-indigo-500 flex items-center space-x-1">
                  <span class="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-ping"></span>
                  <span>可尾部修改</span>
                </span>
                <button 
                  v-if="consumeAmountStr" 
                  @click.stop="clearConsumeAmount"
                  type="button"
                  class="text-xs text-slate-500 hover:text-slate-800 bg-slate-200/80 hover:bg-slate-300 px-2 py-0.5 rounded-full font-bold transition"
                  title="清空金额"
                >
                  ✕ 清空
                </button>
              </div>
            </div>

            <!-- 超大数字显示 (尾部修改光标指示) -->
            <div class="text-5xl font-black text-slate-900 tracking-tight tabular-nums mt-1 flex items-center justify-center py-1" :class="{ 'balance-debt': isConsumeOverBalance }">
              <span class="text-3xl mr-1.5 text-slate-400 font-bold">¥</span>
              <span>{{ consumeAmountStr || '0.00' }}</span>
              <!-- 输入光标效果 (处于激活编辑态时在末尾闪烁，表明在尾部直接修改) -->
              <span 
                v-if="showConsumeKeypad" 
                class="w-1 h-9 bg-indigo-600 ml-1.5 rounded-full animate-pulse"
              ></span>
            </div>

            <div v-if="isConsumeOverBalance" class="debt-warning mt-2" role="status" aria-live="polite">
              <strong>⚠️ {{ consumingMember.balance < 0 ? '客户已有欠款，本次将继续增加欠款' : '本次扣款超出余额，将记为欠款' }}</strong>
              <span>本次新增欠款 ¥{{ formatCent(consumeDebtAdded) }}</span>
              <span class="debt-warning-total">扣款后累计欠款 ¥{{ formatCent(-consumeBalanceAfter) }}</span>
              <span>确认时需勾选知晓欠款，也可先为客户充值。</span>
            </div>
            
            <div v-else class="text-center mt-1.5">
              <span class="text-[11px] font-bold" :class="showConsumeKeypad ? 'text-indigo-500' : 'text-slate-400'">
                💡 点击此处数字或下方服务价格可唤起数字键盘直接修改
              </span>
            </div>
          </div>

          <!-- 常用理发服务一键快捷带入 (点击带入项目金额并弹出键盘) -->
          <div>
            <div class="text-xs font-black text-slate-500 mb-2 flex items-center justify-between">
              <span>点击一键带入常用项目与金额：</span>
              <span class="text-[11px] text-slate-400">改价时点击金额</span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button 
                v-for="item in hairServices" 
                :key="item.id"
                @click="setConsumePreset(item)"
                type="button"
                class="h-11 px-3.5 rounded-2xl border-2 font-black text-sm btn-press flex items-center transition"
                :class="consumeSummary === item.name && consumeAmountStr === item.price.toString() 
                  ? 'border-indigo-600 bg-indigo-50 text-indigo-900 shadow-sm ring-1 ring-indigo-300' 
                  : 'border-slate-200 bg-slate-50 active:bg-indigo-50 active:border-indigo-400 text-slate-800'"
              >
                {{ item.name }} (¥{{ item.price }})
              </button>
            </div>
          </div>

          <!-- 备注输入框 -->
          <div>
            <div class="text-xs font-black text-slate-500 mb-1.5">项目明细备注：</div>
            <input 
              v-model="consumeSummary" 
              type="text" 
              placeholder="项目明细备注 (如：精致洗剪吹 + 护发素)..." 
              class="w-full h-12 text-sm px-4 bg-slate-50 rounded-2xl border-2 border-slate-200/90 focus:border-indigo-500 focus:bg-white outline-none font-bold"
            />
          </div>
        </div>

        <!-- ===== 底部固定下方数字键盘区 (flex-shrink-0，固定下方，绝不随页面滚动) ===== -->
        <div class="flex-shrink-0 bg-slate-100 border-t border-slate-200/90 z-20">
          <!-- 键盘顶端轻量控制条 -->
          <div class="px-4 py-1.5 bg-slate-200/60 border-b border-slate-200/60 flex items-center justify-between text-xs text-slate-600 font-bold select-none">
            <div class="flex items-center space-x-1.5">
              <span class="text-slate-500">⌨️ 数字键盘</span>
              <span class="text-[11px] text-slate-400 font-normal">| 随时修改金额</span>
            </div>
            <button 
              type="button"
              @click="showConsumeKeypad = !showConsumeKeypad"
              class="text-indigo-600 hover:text-indigo-800 font-bold flex items-center space-x-1 px-2 py-0.5 rounded-lg active:bg-slate-300 transition"
            >
              <span>{{ showConsumeKeypad ? '收起键盘' : '展开键盘' }}</span>
              <span class="text-[10px]">{{ showConsumeKeypad ? '▼' : '▲' }}</span>
            </button>
          </div>

          <!-- 展开状态下的软键盘 -->
          <div v-show="showConsumeKeypad">
            <Keypad 
              v-model="consumeAmountStr" 
              confirmText="确认扣除" 
              theme="danger"
              :disabled="!canSubmitConsume || isSubmittingConsume || !canCloudWrite('consume')"
              @confirm="requestConsumeConfirmation" 
            />
          </div>

          <!-- 收起键盘后的吸底紧凑条 -->
          <div v-show="!showConsumeKeypad" class="p-3 bg-white flex items-center gap-3 pb-gesture-safe">
            <button 
              type="button"
              @click="openConsumeKeypad"
              class="flex-1 h-13 bg-slate-100 border-2 border-slate-200 hover:border-indigo-300 rounded-2xl flex items-center justify-between px-4 text-slate-700 font-bold active:bg-slate-200 transition"
            >
              <span class="flex items-center space-x-2">
                <span class="text-xl">⌨️</span>
                <span class="text-sm">点击弹出数字键盘修改</span>
              </span>
              <span class="text-rose-600 font-black tabular-nums text-lg">
                ¥ {{ consumeAmountStr || '0.00' }}
              </span>
            </button>

            <button 
              type="button"
              @click="requestConsumeConfirmation"
              :disabled="isSubmittingConsume || !canSubmitConsume || !canCloudWrite('consume')"
              class="consume-submit h-13 px-6 text-white font-black text-base rounded-2xl disabled:opacity-50 btn-press flex items-center justify-center whitespace-nowrap" :class="{ 'consume-submit-debt': isConsumeOverBalance }"
            >
              {{ isConsumeOverBalance ? '核对欠款' : '确认扣除' }}
            </button>
          </div>
          <button v-if="isConsumeOverBalance" type="button" class="consume-recharge-link" :disabled="!canCloudWrite('recharge')" @click="rechargeFromConsume">先充值 / 还款</button>
        </div>
      </div>
    </div>

    <!-- 2. 会员储值充值抽屉 -->
    <div 
      v-if="rechargingMember" 
      class="fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in backdrop-blur-xs"
      @click.self="rechargingMember = null"
    >
      <div class="bg-white rounded-t-[32px] max-h-[92vh] flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full">
        <!-- 弹窗把手 -->
        <div class="w-12 h-1.5 bg-slate-300 rounded-full mx-auto my-2.5"></div>

        <div class="modal-header px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div class="modal-header-copy">
            <div class="modal-title font-black text-xl text-slate-900">
              💳 会员储值 — {{ rechargingMember.name }}
            </div>
            <div class="text-sm text-slate-500 font-semibold mt-0.5">
              {{ rechargingMember.balance < 0 ? '当前欠款' : '可用余额' }}：<strong class="text-indigo-600 font-black text-base" :class="{ 'balance-debt': rechargingMember.balance < 0 }">¥ {{ formatCent(Math.abs(rechargingMember.balance)) }}</strong>
            </div>
          </div>
          <button @click="rechargingMember = null" class="w-10 h-10 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xl font-bold btn-press">✕</button>
        </div>

        <div class="p-5 overflow-y-auto space-y-4">
          <div v-if="rechargingMember.balance < 0" class="debt-warning"><strong>充值到账额度将优先抵扣欠款</strong><span>当前欠款 ¥{{ formatCent(-rechargingMember.balance) }}，结清后剩余金额转为可用余额。</span></div>
          <!-- 快捷充值档位 (放大卡片) -->
          <div>
            <div class="text-xs font-black text-slate-500 mb-2.5">快捷充值套餐</div>
            <div class="recharge-plans grid grid-cols-3 gap-3">
              <button 
                v-for="plan in rechargePlans" 
                :key="plan.pay"
                @click="applyRechargePlan(plan)"
                class="p-3.5 rounded-2xl border-2 text-center transition btn-press"
                :class="rechargeForm.actualPay == plan.pay && rechargeForm.giftAmount == plan.gift ? 'border-emerald-500 bg-emerald-50 text-emerald-900 font-black shadow-sm' : 'border-slate-200 bg-slate-50 text-slate-700 font-bold'"
              >
                <div class="text-lg font-black">充¥{{ plan.pay }}</div>
                <div class="text-xs text-emerald-600 font-black mt-0.5">
                  {{ plan.gift > 0 ? `送¥${plan.gift}` : '到账¥' + plan.pay }}
                </div>
              </button>
            </div>
          </div>

          <!-- 自定义实收与赠送 (输入框大高度56px，高对比) -->
          <div class="space-y-3.5 bg-slate-50 p-4.5 rounded-3xl border border-slate-200/90">
            <div>
              <label class="text-sm font-black text-slate-800 block mb-1.5">实收充值金额 (元) <span class="text-rose-500">*</span></label>
              <input 
                v-model.number="rechargeForm.actualPay" 
                type="number" 
                min="0"
                step="0.01" 
                placeholder="0.00"
                class="w-full h-14 bg-white px-4 text-xl font-black text-slate-900 rounded-2xl border-2 border-slate-300 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
              />
            </div>

            <div>
              <label class="text-sm font-black text-slate-800 block mb-1.5">额外赠送额度 (元，可填0)</label>
              <input 
                v-model.number="rechargeForm.giftAmount" 
                type="number" 
                min="0"
                step="0.01" 
                placeholder="0.00"
                class="w-full h-14 bg-white px-4 text-xl font-black text-emerald-600 rounded-2xl border-2 border-slate-300 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100"
              />
            </div>

            <div class="pt-3 border-t border-slate-200 flex justify-between items-center text-sm">
              <span class="text-slate-700 font-black">实际到账总额度：</span>
              <span class="font-black text-emerald-600 text-2xl tabular-nums">
                ¥ {{ ((Number(rechargeForm.actualPay || 0) + Number(rechargeForm.giftAmount || 0))).toFixed(2) }}
              </span>
            </div>
          </div>

          <!-- 收款渠道 (放大按钮50px) -->
          <div>
            <div class="text-xs font-black text-slate-500 mb-2.5">收款渠道</div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-sm font-black">
              <button 
                v-for="m in ['微信支付', '支付宝', '现金收款', '其他方式']"
                :key="m"
                @click="rechargeForm.payMethod = m"
                class="h-12 rounded-2xl border-2 text-center transition flex items-center justify-center btn-press"
                :class="rechargeForm.payMethod === m ? 'border-emerald-500 bg-emerald-50 text-emerald-900 font-black shadow-sm' : 'border-slate-200 text-slate-600 font-bold'"
              >
                {{ m }}
              </button>
            </div>
          </div>

          <!-- 充值备注 (放大到52px) -->
          <div>
            <label class="text-sm font-black text-slate-800 block mb-1.5">充值备注说明 (选填)</label>
            <input 
              v-model="rechargeForm.remark" 
              type="text" 
              placeholder="例：周年店庆活动储值" 
              class="w-full h-13 text-base px-4 bg-slate-50 rounded-2xl border-2 border-slate-200 outline-none font-bold focus:bg-white focus:border-emerald-500"
            />
          </div>
        </div>

        <div class="p-5 border-t border-slate-100 bg-white pb-gesture-safe">
          <button 
            @click="requestRechargeConfirmation"
            :disabled="!canSubmitRecharge || isSubmittingRecharge || !canCloudWrite('recharge')"
            class="w-full h-14 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 active:from-emerald-800 active:to-teal-800 disabled:bg-slate-300 text-white rounded-2xl font-black text-lg shadow-lg shadow-emerald-500/25 btn-press"
          >
            核对充值信息
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="rechargeConfirmation"
      class="feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-5 animate-fade-in"
      @click.self="rechargeConfirmation = null"
    >
      <section class="feedback-dialog w-full max-w-sm bg-white text-center shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="recharge-confirm-title">
        <div class="feedback-icon feedback-icon-success mx-auto">¥</div>
        <h2 id="recharge-confirm-title" class="mt-4 text-2xl font-black text-slate-900">请再核对一次</h2>
        <p class="mt-2 text-base text-slate-700">确认后将立即为 {{ rechargeConfirmation.memberName }} 充值入账。</p>
        <div class="feedback-amount mt-5 rounded-xl px-4 py-4 text-left">
          <div class="flex justify-between gap-3 text-base"><span>实收金额</span><strong>¥{{ rechargeConfirmation.actualPay.toFixed(2) }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-base"><span>赠送额度</span><strong>¥{{ rechargeConfirmation.giftAmount.toFixed(2) }}</strong></div>
          <div class="mt-3 border-t border-emerald-200 pt-3 flex justify-between gap-3 text-lg font-black text-emerald-800"><span>总到账</span><strong>¥{{ (rechargeConfirmation.actualPay + rechargeConfirmation.giftAmount).toFixed(2) }}</strong></div>
          <div class="mt-2 text-sm text-slate-600">收款方式：{{ rechargeConfirmation.payMethod }}</div>
          <div v-if="rechargeConfirmation.currentBalance < 0" class="recharge-debt-preview">
            <div>本次抵扣欠款 <strong>¥{{ formatCent(rechargeConfirmation.debtRepaid) }}</strong></div>
            <div :class="{ 'balance-debt': rechargeConfirmation.balanceAfter < 0 }">{{ rechargeConfirmation.balanceAfter < 0 ? '充值后仍欠款' : '充值后可用余额' }} <strong>¥{{ formatCent(Math.abs(rechargeConfirmation.balanceAfter)) }}</strong></div>
          </div>
        </div>
        <div class="mt-6 grid grid-cols-2 gap-3">
          <button @click="rechargeConfirmation = null" class="h-14 rounded-xl border-2 border-slate-300 text-base font-bold text-slate-700 btn-press">返回修改</button>
          <button @click="confirmRecharge" :disabled="isSubmittingRecharge || !canCloudWrite('recharge')" class="h-14 rounded-xl bg-emerald-700 text-base font-black text-white btn-press disabled:opacity-60">确认充值</button>
        </div>
      </section>
    </div>

    <!-- 消费金额确认框 (二次防误触核对，先弹出消费金额确认框) -->
    <div
      v-if="consumeConfirmation"
      class="feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-5 animate-fade-in backdrop-blur-xs"
      @click.self="consumeConfirmation = null"
    >
      <section 
        class="feedback-dialog consume-confirm-dialog w-full max-w-sm bg-white text-center shadow-2xl"
        :class="{ 'debt-confirm-dialog': consumeConfirmation.balanceAfter < 0 }"
        :role="consumeConfirmation.balanceAfter < 0 ? 'alertdialog' : 'dialog'"
        aria-modal="true" 
        aria-labelledby="consume-confirm-title"
      >
        <div class="feedback-icon mx-auto text-3xl font-black bg-rose-100 text-rose-600"><CircleAlert v-if="consumeConfirmation.balanceAfter < 0" :size="30" aria-hidden="true" /><span v-else aria-hidden="true">✂️</span></div>
        <h2 id="consume-confirm-title" class="mt-4 text-2xl font-black text-slate-900" :class="{ 'balance-debt': consumeConfirmation.balanceAfter < 0 }">{{ consumeConfirmation.balanceAfter < 0 ? '注意：本次扣款将产生欠款' : '请核对扣款金额' }}</h2>
        <p class="mt-2 text-base text-slate-700">{{ consumeConfirmation.balanceAfter < 0 ? '确认后将记录服务消费和欠款，请核对客户与金额。' : `确认后将立即从 ${consumeConfirmation.memberName} 会员卡中扣款。` }}</p>
        <div class="feedback-amount mt-5 rounded-xl px-4 py-4 text-left">
          <div class="flex justify-between gap-3 text-base"><span>消费会员</span><strong class="text-slate-900">{{ consumeConfirmation.memberName }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-sm"><span>手机号</span><strong>{{ formatPhoneSpaced(consumeConfirmation.memberPhone) }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-base"><span>服务项目</span><strong class="text-slate-800 max-w-[170px] truncate text-right">{{ consumeConfirmation.itemsSummary }}</strong></div>
          <div class="mt-2 flex justify-between gap-3 text-base"><span>{{ consumeConfirmation.currentBalance < 0 ? '原有欠款' : '当前余额' }}</span><strong :class="{ 'balance-debt': consumeConfirmation.currentBalance < 0 }">¥{{ formatCent(Math.abs(consumeConfirmation.currentBalance)) }}</strong></div>
          <div class="mt-3 border-t border-rose-200 pt-3 flex justify-between items-baseline gap-3 text-xl font-black text-rose-700">
            <span>扣款金额</span>
            <strong class="text-2xl tabular-nums">¥{{ consumeConfirmation.amount.toFixed(2) }}</strong>
          </div>
          <div class="mt-2.5 border-t border-dashed border-rose-200/80 pt-2 flex justify-between gap-3 text-sm text-slate-600 font-semibold">
            <span>{{ consumeConfirmation.balanceAfter < 0 ? '扣款后累计欠款' : '扣款后可用余额' }}</span>
            <strong class="text-indigo-600 font-black tabular-nums" :class="{ 'balance-debt': consumeConfirmation.balanceAfter < 0 }">¥{{ formatCent(Math.abs(consumeConfirmation.balanceAfter)) }}</strong>
          </div>
        </div>
        <div v-if="consumeConfirmation.balanceAfter < 0" class="debt-confirm-warning">
          <strong>新增欠款 ¥{{ formatCent(consumeConfirmation.debtAdded) }}</strong>
          <p>确认后余额为负数，该客户累计欠款 ¥{{ formatCent(-consumeConfirmation.balanceAfter) }}，需后续收款结清。</p>
          <label class="debt-acknowledgement"><input v-model="debtAcknowledged" type="checkbox" /><span>我已知晓并同意记录本次欠款</span></label>
        </div>
        <div class="mt-6 grid grid-cols-2 gap-3">
          <button @click="consumeConfirmation = null" class="h-14 rounded-xl border-2 border-slate-300 text-base font-bold text-slate-700 btn-press">返回修改</button>
          <button @click="confirmConsume" :disabled="isSubmittingConsume || !canCloudWrite('consume') || (consumeConfirmation.balanceAfter < 0 && !debtAcknowledged)" class="consume-submit h-14 rounded-xl text-base font-black text-white btn-press disabled:opacity-60 flex items-center justify-center space-x-1.5" :class="{ 'consume-submit-debt': consumeConfirmation.balanceAfter < 0 }">
            <span v-if="isSubmittingConsume">扣款中...</span>
            <span v-else>{{ consumeConfirmation.balanceAfter < 0 ? '确认并记欠款' : '确认扣款' }}</span>
          </button>
        </div>
      </section>
    </div>

    <!-- 备份恢复与智能对账弹窗 -->
    <div
      v-if="backupRestoreRequest"
      class="feedback-backdrop fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fade-in"
      @click.self="backupRestoreRequest = null"
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
              <span class="font-bold text-slate-700 truncate max-w-[200px]">{{ backupRestoreRequest.fileName }}</span>
            </div>
            <div class="flex justify-between text-slate-500">
              <span>备份导出时间</span>
              <span class="font-bold text-slate-700">{{ formatTime(backupRestoreRequest.preview?.exportedAt) || '未知' }}</span>
            </div>
            <div class="flex justify-between text-slate-500">
              <span>备份内包含</span>
              <span class="font-black text-indigo-700">{{ backupRestoreRequest.preview?.backupStats?.memberCount || 0 }} 位会员 · {{ backupRestoreRequest.preview?.backupStats?.ledgerCount || 0 }} 笔流水 · ¥{{ formatCent(backupRestoreRequest.preview?.backupStats?.totalBalance || 0) }}</span>
            </div>
          </div>

          <!-- 当前手机系统数据对比 -->
          <div class="bg-indigo-50/60 p-3 rounded-2xl border border-indigo-100 flex justify-between items-center text-xs">
            <span class="text-indigo-950 font-bold">当前手机现有账本：</span>
            <span v-if="backupRestoreRequest.preview.currentDataError" class="font-black text-rose-700">读取异常，无法统计</span>
            <span v-else class="font-black text-indigo-900">{{ backupRestoreRequest.preview?.currentStats?.memberCount || 0 }} 位会员 · {{ backupRestoreRequest.preview?.currentStats?.ledgerCount || 0 }} 笔流水</span>
          </div>

          <!-- 智能差异提示 -->
          <div v-if="backupRestoreRequest.preview?.diff?.hasNewerLocalData" class="p-3 bg-amber-50 border border-amber-200 rounded-2xl text-amber-900 font-bold space-y-1">
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
              <div class="font-black text-sm text-emerald-600">+{{ backupRestoreRequest.preview?.diff?.newMembersCount || 0 }} 人</div>
            </div>
            <div>
              <div class="text-[11px] text-slate-400">补充历史流水</div>
              <div class="font-black text-sm text-emerald-600">+{{ backupRestoreRequest.preview?.diff?.newLedgersCount || 0 }} 笔</div>
            </div>
            <div>
              <div class="text-[11px] text-slate-400">跳过重复流水</div>
              <div class="font-black text-sm text-slate-500">{{ backupRestoreRequest.preview?.diff?.duplicateLedgersCount || 0 }} 笔</div>
            </div>
          </div>
        </div>

        <div v-if="backupRestoreRequest.preview.mergeError" class="mt-3 p-3 rounded-2xl border border-rose-300 bg-rose-50 text-sm text-rose-900">
          <p class="font-black">此备份无法自动合并</p>
          <p class="mt-1">{{ backupRestoreRequest.preview.mergeError }}。请核对后选择完整账本进行全量恢复，当前原始数据会先保留。</p>
        </div>

        <!-- 恢复模式单选切换 -->
        <div class="mt-4 space-y-2">
          <div class="text-xs font-black text-slate-700">选择恢复方式：</div>
          
          <label 
            class="flex items-start p-3 rounded-2xl border-2 transition cursor-pointer"
            :class="restoreMode === 'merge' ? 'border-emerald-500 bg-emerald-50/70 shadow-xs' : 'border-slate-200 bg-white'"
          >
            <input type="radio" value="merge" v-model="restoreMode" :disabled="Boolean(backupRestoreRequest.preview.mergeError)" class="mt-1 mr-2.5 text-emerald-600" />
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
            :class="restoreMode === 'replace' ? 'border-rose-500 bg-rose-50/70 shadow-xs' : 'border-slate-200 bg-white'"
          >
            <input type="radio" value="replace" v-model="restoreMode" class="mt-1 mr-2.5 text-rose-600" />
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
            @click="backupRestoreRequest = null" 
            :disabled="isRestoringBackup"
            class="h-13 rounded-2xl border-2 border-slate-300 text-sm font-bold text-slate-700 btn-press"
          >
            取消
          </button>
          <button 
            @click="confirmBackupRestore" 
            :disabled="isRestoringBackup || !canCloudWrite('importBackupData') || (restoreMode === 'merge' && Boolean(backupRestoreRequest.preview.mergeError))"
            class="h-13 rounded-2xl text-sm font-black text-white btn-press disabled:opacity-60 shadow-md shadow-emerald-600/20"
            :class="restoreMode === 'merge' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'"
          >
            {{ isRestoringBackup ? '正在安全恢复...' : (restoreMode === 'merge' ? '确认增量合并' : '确认完全覆盖') }}
          </button>
        </div>
      </section>
    </div>

    <!-- 3. 会员详情卡片抽屉 (点击会员查看全貌) -->
    <div 
      v-if="selectedMember" 
      class="fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in backdrop-blur-xs"
      @click.self="selectedMember = null"
    >
      <div class="member-detail-sheet bg-white rounded-t-[32px] max-h-[90vh] flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full">
        <!-- 弹窗把手 -->
        <div class="w-12 h-1.5 bg-slate-300 rounded-full mx-auto my-2.5"></div>

        <div class="modal-header px-5 py-3 border-b border-slate-100 flex items-center justify-between">
          <div class="member-detail-header-copy flex items-center space-x-3.5">
            <div class="w-13 h-13 rounded-2xl bg-gradient-to-tr from-indigo-700 to-slate-900 text-white flex items-center justify-center font-black text-2xl shadow-sm">
              {{ selectedMember.name.charAt(0) }}
            </div>
            <div>
              <div class="flex flex-wrap items-center gap-1.5">
                <button class="copyable-text font-black text-xl text-slate-900" @click.stop="copyMemberField(selectedMember.name, '姓名')" aria-label="复制会员姓名">{{ selectedMember.name }}</button>
                <span class="text-xs bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full font-black" :class="{ 'debt-tag': selectedMember.balance < 0 }">{{ selectedMember.balance < 0 ? '尚有欠款' : '客户档案' }}</span>
              </div>
              <button class="copyable-text block text-base text-slate-600 font-mono font-black" @click.stop="copyMemberField(selectedMember.phone, '手机号')" aria-label="复制会员手机号">{{ formatPhoneSpaced(selectedMember.phone) }}</button>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <button 
              @click="openEditMemberModal(selectedMember)"
              class="h-9 px-3.5 bg-indigo-50 border border-indigo-200 text-indigo-700 rounded-xl font-bold text-xs active:bg-indigo-100 btn-press"
            >
              修改档案
            </button>
            <button 
              @click="selectedMember = null" 
              class="w-10 h-10 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xl font-bold btn-press"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="member-detail-content flex-1 overflow-y-auto p-5 space-y-4">
          <!-- 醒目大额度黑金渐变卡片 -->
          <div class="member-balance-panel rounded-3xl p-5" :class="{ 'member-balance-debt': selectedMember.balance < 0 }">
            <div class="text-xs font-black">{{ selectedMember.balance < 0 ? '客户当前欠款' : '当前可用余额' }}</div>
            <div class="text-4xl font-black tracking-tight mt-1.5 tabular-nums">
              {{ selectedMember.balance < 0 ? '−' : '' }}¥ {{ formatCent(Math.abs(selectedMember.balance)) }}
            </div>
            <p v-if="selectedMember.balance < 0" class="mt-2 font-bold">待收回 ¥{{ formatCent(-selectedMember.balance) }}，充值将自动抵扣欠款。</p>

            <div class="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-slate-800/80 text-xs">
              <div>
                <span class="text-slate-400 font-medium">历史累计储值：</span>
                <span class="font-bold tabular-nums">¥{{ formatCent(selectedMember.total_recharge) }}</span>
              </div>
              <div>
                <span class="text-slate-400 font-medium">历史累计消费：</span>
                <span class="font-bold tabular-nums">¥{{ formatCent(selectedMember.total_consume) }}</span>
              </div>
            </div>
          </div>

          <!-- 发型偏好说明 -->
          <div v-if="selectedMember.notes" class="bg-amber-50 p-4 rounded-2xl border border-amber-200 text-sm text-amber-900 font-bold">
            💇 发型习惯偏好：<span class="font-normal">{{ selectedMember.notes }}</span>
          </div>

          <!-- 近期交易明细 -->
          <div>
            <div class="text-xs font-black uppercase tracking-wider text-slate-500 mb-2.5">
              近期消费与充值记录 ({{ currentMemberLedgers.length }})
            </div>

            <div v-if="currentMemberLedgers.length === 0" class="text-sm text-slate-400 py-4 text-center font-bold">
              暂无历史记录
            </div>
            <div v-else class="space-y-2.5">
              <div 
                v-for="l in currentMemberLedgers" 
                :key="l.id"
                class="bg-slate-50 p-3.5 rounded-2xl border border-slate-200 flex items-center justify-between text-xs"
              >
                <div>
                  <div class="flex items-center space-x-2">
                    <span 
                      class="px-2 py-0.5 rounded-lg text-[11px] font-black"
                      :class="getBadgeClass(l.type)"
                    >
                      {{ getTypeText(l.type) }}
                    </span>
                    <span class="font-black text-slate-800 text-sm">{{ l.remark || '无' }}</span>
                  </div>
                  <div class="text-slate-400 mt-1 font-medium">
                    {{ formatTime(l.created_at) }}
                  </div>
                </div>

                <div class="text-right">
                  <div 
                    class="font-black tabular-nums text-base"
                    :class="l.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
                  >
                    {{ l.changeAmount > 0 ? '+' : '' }}{{ (l.changeAmount / 100).toFixed(2) }}
                  </div>
                  <div class="text-slate-400 font-medium">
                    <span :class="{ 'balance-debt': l.balanceAfter < 0 }">{{ l.balanceAfter < 0 ? '欠款' : '余额' }}: ¥{{ formatCent(Math.abs(l.balanceAfter)) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 删除会员 (仅当余额为0时) -->
          <div v-if="selectedMember.balance === 0" class="pt-2 text-center">
            <button 
              @click="handleDeleteMember(selectedMember)"
              :disabled="!canCloudWrite('deleteMember')"
              class="text-xs text-rose-500 underline font-bold"
            >
              删除注销此会员档案 (仅限余额为0)
            </button>
          </div>
        </div>

        <!-- 底部快捷充值与扣款 (大按钮52px) -->
        <div class="member-detail-actions border-t border-slate-200 bg-white grid grid-cols-2 pb-gesture-safe">
          <button 
            @click="openRechargeModal(selectedMember)"
            :disabled="!canCloudWrite('recharge')"
            class="h-13 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-2xl font-black text-base shadow-md shadow-emerald-500/20 flex items-center justify-center space-x-1.5 btn-press"
          >
            <span class="detail-action-icon" aria-hidden="true">💳</span><span>{{ selectedMember.balance < 0 ? '充值 / 还款' : '额度充值' }}</span>
          </button>

          <button 
            @click="openConsumeModal(selectedMember)"
            :disabled="!canCloudWrite('consume')"
            class="h-13 bg-gradient-to-r from-rose-500 to-rose-600 hover:from-rose-600 hover:to-rose-700 text-white rounded-2xl font-black text-base shadow-md shadow-rose-500/20 flex items-center justify-center space-x-1.5 btn-press"
          >
            <span class="detail-action-icon" aria-hidden="true">✂️</span><span>剪发扣款</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 4. 新增/编辑会员档案弹窗 (输入框放大到54px，标签清晰高对比) -->
    <div 
      v-if="showMemberModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
      @click.self="showMemberModal = false"
    >
      <div class="modal-dialog bg-white rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
        <div class="flex items-center justify-between border-b pb-3">
          <h3 class="font-black text-xl text-slate-900">
            {{ editingMemberId ? '修改会员档案' : '登记新会员档案' }}
          </h3>
          <button @click="showMemberModal = false" class="text-slate-400 text-xl font-bold btn-press">✕</button>
        </div>

        <div class="space-y-4 text-sm">
          <div>
            <label class="font-black text-slate-800 block mb-1.5">客户姓名 <span class="text-rose-500">*</span></label>
            <input 
              v-model="memberForm.name" 
              type="text" 
              placeholder="如：张姐 / 8号熟客" 
              class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
            />
          </div>

          <div>
            <label class="font-black text-slate-800 block mb-1.5">手机号码 <span class="text-rose-500">*</span></label>
            <input 
              v-model="memberForm.phone" 
              type="tel" 
              placeholder="报手机尾号查找的唯一依据" 
              class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-mono font-black text-base"
            />
          </div>

          <div v-if="!editingMemberId">
            <label class="font-black text-slate-800 block mb-1.5">开卡初始储值额 (元，可填0)</label>
            <input 
              v-model.number="memberForm.initialBalance" 
              type="number" 
              step="0.01" 
              placeholder="0.00" 
              class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
            />
          </div>

          <div>
            <label class="font-black text-slate-800 block mb-1.5">发型与习惯偏好备注</label>
            <textarea 
              v-model="memberForm.notes" 
              rows="2" 
              placeholder="如：短发圆寸、染发板栗色、不喜欢推子太贴皮等" 
              class="w-full p-3.5 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 resize-none font-bold text-sm"
            ></textarea>
          </div>
        </div>

        <div class="flex space-x-3 pt-2">
          <button 
            @click="showMemberModal = false"
            class="flex-1 h-13 rounded-2xl border-2 border-slate-300 text-sm font-black text-slate-600 active:bg-slate-100 btn-press"
          >
            取消
          </button>
          <button 
            @click="submitMemberForm"
            :disabled="isSavingMember || !canCloudWrite(editingMemberId ? 'updateMember' : 'createMember') || !memberForm.name.trim() || !memberForm.phone.trim()"
            class="flex-1 h-13 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-sm font-black text-white shadow-md shadow-indigo-500/20 btn-press"
          >
            保存档案
          </button>
        </div>
      </div>
    </div>

    <!-- 5. 服务定价增改弹窗 (输入框放大到54px) -->
    <div 
      v-if="showServiceModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
      @click.self="showServiceModal = false"
    >
      <div class="modal-dialog bg-white rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl">
        <div class="flex items-center justify-between border-b pb-3">
          <h3 class="font-black text-xl text-slate-900">
            {{ serviceForm.id ? '修改服务项目' : '新增服务项目' }}
          </h3>
          <button @click="showServiceModal = false" class="text-slate-400 text-xl font-bold btn-press">✕</button>
        </div>

        <div class="space-y-4 text-sm">
          <div>
            <label class="font-black text-slate-800 block mb-1.5">服务项目名称 <span class="text-rose-500">*</span></label>
            <input 
              v-model="serviceForm.name" 
              type="text" 
              placeholder="如：洗剪吹 / 精油护理" 
              class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
            />
          </div>

          <div>
            <label class="font-black text-slate-800 block mb-1.5">默认价格 (元) <span class="text-rose-500">*</span></label>
            <input 
              v-model.number="serviceForm.price" 
              type="number" 
              step="0.01" 
              placeholder="0.00" 
              class="w-full h-14 px-4 border-2 border-slate-300 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 font-black text-base"
            />
          </div>
        </div>

        <div class="flex space-x-3 pt-2">
          <button 
            @click="showServiceModal = false"
            class="flex-1 h-13 rounded-2xl border-2 border-slate-300 text-sm font-black text-slate-600 active:bg-slate-100 btn-press"
          >
            取消
          </button>
          <button 
            @click="submitServiceForm"
            :disabled="isSavingService || !canCloudWrite('saveService') || !serviceForm.name || serviceForm.price === ''"
            class="flex-1 h-13 rounded-2xl bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-sm font-black text-white shadow-md shadow-indigo-500/20 btn-press"
          >
            保存项目
          </button>
        </div>
      </div>
    </div>

    <!-- 6. 充值微信致谢通知卡片 -->
    <div 
      v-if="receiptModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in backdrop-blur-xs"
      @click.self="receiptModal = null"
    >
      <div class="modal-dialog bg-white rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl text-center">
        <div class="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto text-3xl font-black">
          ✓
        </div>
        <h3 class="font-black text-slate-900 text-2xl">充值入账成功</h3>
        <p class="text-sm text-slate-500 font-bold">已为会员 {{ receiptModal.name }} 存入额度</p>

        <div class="bg-slate-50 p-4 rounded-2xl border border-slate-200 text-left text-xs text-slate-800 leading-relaxed font-mono">
          {{ receiptModal.messageText }}
        </div>

        <button 
          @click="copyReceiptText(receiptModal.messageText)"
          class="w-full h-13 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white rounded-2xl text-base font-black shadow-md shadow-indigo-500/25 btn-press"
        >
          📋 一键复制致谢文案 (微信发给顾客)
        </button>

        <button 
          @click="receiptModal = null"
          class="w-full py-2.5 text-slate-400 text-sm font-bold btn-press"
        >
          关闭
        </button>
      </div>
    </div>

    <!-- 浮动 Toast 消息通知 -->
    <div 
      v-if="toastMessage" 
      class="app-toast fixed top-24 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-md text-white text-sm font-black px-6 py-3.5 rounded-full shadow-2xl z-50 animate-fade-in flex items-center space-x-2 border border-slate-700"
    >
      <span>ℹ️</span>
      <span>{{ toastMessage }}</span>
    </div>

    <div
      v-if="feedbackModal"
      class="feedback-backdrop fixed inset-0 z-[70] flex items-center justify-center p-5 animate-fade-in"
      @click.self="feedbackModal = null"
      role="presentation"
    >
      <section
        class="feedback-dialog w-full max-w-sm bg-white text-center shadow-2xl"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="'feedback-title'"
      >
        <div class="feedback-icon mx-auto" :class="feedbackModal.type === 'success' ? 'feedback-icon-success' : 'feedback-icon-error'">
          {{ feedbackModal.type === 'success' ? '✓' : '!' }}
        </div>
        <h2 id="feedback-title" class="mt-4 text-2xl font-black text-slate-900">{{ feedbackModal.title }}</h2>
        <p class="mt-2 text-base leading-relaxed text-slate-700">{{ feedbackModal.message }}</p>
        <div v-if="feedbackModal.amount" class="feedback-amount mt-5 rounded-xl px-4 py-3">
          <div class="text-sm font-bold text-slate-600">本次扣款</div>
          <div class="mt-1 text-3xl font-black tabular-nums text-rose-700">¥ {{ feedbackModal.amount }}</div>
          <div class="mt-2 text-base font-bold text-slate-700" :class="{ 'balance-debt': feedbackModal.debt }">{{ feedbackModal.memberName }} · {{ feedbackModal.debt ? '累计欠款' : '扣后余额' }} ¥{{ feedbackModal.debt || feedbackModal.balance }}</div>
        </div>
        <button
          @click="feedbackModal = null"
          class="feedback-confirm mt-6 w-full h-14 rounded-xl text-lg font-black text-white btn-press"
          :class="feedbackModal.type === 'success' ? 'bg-emerald-700' : 'bg-slate-800'"
          autofocus
        >
          知道了
        </button>
      </section>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { localDb } from './storage.js';
import { isValidMoney, moneyToCent } from './money.js';
import { exportFile, isExportCancelled } from './file-export.js';
import Keypad from './components/Keypad.vue';
import CloudSettings from './components/CloudSettings.vue';
import Customers from './components/Customers.vue';
import { UsersRound, ReceiptText, Settings, Search, CircleAlert } from 'lucide-vue-next';
import { cloudClient, copyToClipboard } from './cloud-device.js';
import { canWrite } from './sync-protocol.js';

// 页面标签：'customers' | 'ledgers' | 'settings'
const activeTab = ref('customers');
const ledgerView = ref('transactions');
const isNativeApp = Capacitor.isNativePlatform();
const settingsPath = ref([]);
const settingsPage = computed(() => settingsPath.value.at(-1) || 'overview');
const settingsTitles = { account: '账号与同步', services: '服务与价格', backup: '数据备份', 'backup-files': '导出与恢复', snapshots: '本地快照', 'file-guide': '文件保存指南', users: '账号管理', activity: '使用记录', update: '应用更新', help: '使用帮助' };
const backupEntries = [
  { page: 'backup-files', title: '导出与恢复', description: '备份完整账本、导出 Excel、恢复备份', icon: '📤' },
  { page: 'snapshots', title: '本地快照', description: '归档、查看与恢复手机内的账本快照', icon: '📁' },
  ...(isNativeApp ? [{ page: 'file-guide', title: '文件保存指南', description: '保存到文件管理器或微信', icon: '📄' }] : [])
];
const settingsGroups = computed(() => [
  { title: '日常经营', items: [{ page: 'services', title: '服务与价格', description: '管理理发项目与默认价格', icon: '💈' }] },
  { title: '账号与云端', items: [
    { page: 'account', title: '账号与同步', description: '登录、同步状态与离线待办', icon: '☁️' },
    ...(cloudState.value.user?.role === 'owner' ? [
      { page: 'users', title: '账号管理', description: '店员账号、权限与停用', icon: '👥' },
      { page: 'activity', title: '使用记录', description: '查看门店最近操作', icon: '📋' }
    ] : [])
  ] },
  { title: '数据安全', items: [{ page: 'backup', title: '数据备份', description: '导出恢复、本地快照与保存指南', icon: '🛡️' }] },
  { title: '应用', items: [
    { page: 'update', title: '应用更新', description: '检查并安装新版本', icon: '⬆️' },
    { page: 'help', title: '使用帮助', description: '离线记账、同步与备份说明', icon: '💡' }
  ] }
]);
function openSettings(page = 'overview') {
  activeTab.value = 'settings';
  settingsPath.value = page === 'overview' ? [] : backupEntries.some(entry => entry.page === page) ? ['backup', page] : [page];
  window.scrollTo?.(0, 0);
}
function openSettingsPage(page) {
  settingsPath.value = [...settingsPath.value, page];
  window.scrollTo?.(0, 0);
}
function backInSettings() {
  settingsPath.value = settingsPath.value.slice(0, -1);
  window.scrollTo?.(0, 0);
}

// 全局响应式状态
const dashboard = ref({});
const membersList = ref([]);
const customerLedgers = ref([]);
const customerFilter = ref('recent');
const ledgersList = ref([]);
const hairServices = ref([]);
const rechargePlans = ref([]);
const searchQuery = ref('');
const ledgerSearchQuery = ref('');
const toastMessage = ref('');
let toastTimer = null;
const feedbackModal = ref(null);
const storageError = ref('');
const isExporting = ref(false);

// 选中的会员卡片
const selectedMember = ref(null);

// 剪发扣款抽屉
const consumingMember = ref(null);
const consumeAmountStr = ref('');
const consumeSummary = ref('精致洗剪吹');
const isSubmittingConsume = ref(false);
const showConsumeKeypad = ref(true);
const consumeConfirmation = ref(null);
const debtAcknowledged = ref(false);

// 储值充值抽屉
const rechargingMember = ref(null);
const rechargeForm = ref({
  actualPay: '',
  giftAmount: 0,
  payMethod: '微信支付',
  remark: ''
});
const rechargeConfirmation = ref(null);
const isSubmittingRecharge = ref(false);

// 新建/修改会员
const showMemberModal = ref(false);
const isSavingMember = ref(false);
const editingMemberId = ref(null);
const memberForm = ref({
  name: '',
  phone: '',
  initialBalance: 0,
  notes: ''
});

// 服务项目增删改
const showServiceModal = ref(false);
const isSavingService = ref(false);
const serviceForm = ref({
  id: '',
  name: '',
  price: 38
});

// 微信通知
const receiptModal = ref(null);
const backupRestoreRequest = ref(null);
const isRestoringBackup = ref(false);
const localSnapshots = ref([]);
const restoreMode = ref('merge');
const ledgerFilterType = ref('');
const cloudState = ref(cloudClient.snapshot());
const cloudLocked = computed(() => !isNativeApp && !cloudState.value.user);
const connectionLabel = computed(() => {
  if (!cloudState.value.user) return isNativeApp ? '本机离线账本' : '请登录';
  if (!cloudState.value.online) return '离线记账';
  if (cloudState.value.syncLoginRequired) return '本机使用 · 同步需登录';
  if (cloudState.value.status === 'conflict') return '联网 · 待核对';
  if (cloudState.value.outbox.length) return `联网 · 待同步 ${cloudState.value.outbox.length} 笔`;
  return '在线同步';
});
const compactConnectionLabel = computed(() => {
  if (!cloudState.value.user) return isNativeApp && !cloudState.value.binding ? '本机' : '未登录';
  if (!cloudState.value.online) return '离线';
  if (cloudState.value.syncLoginRequired) return '待登录';
  if (cloudState.value.status === 'conflict') return '待核对';
  return cloudState.value.outbox.length ? '待同步' : '已同步';
});
const stopCloudSubscription = cloudClient.subscribe(state => {
  cloudState.value = state;
  if (!state.user && !isNativeApp) {
    activeTab.value = 'settings'; selectedMember.value = null; consumingMember.value = null; rechargingMember.value = null;
    showMemberModal.value = false; showServiceModal.value = false; receiptModal.value = null; backupRestoreRequest.value = null;
  }
});
function canCloudWrite(method) { return !cloudState.value.binding || canWrite(cloudState.value.user?.role, method); }

const headerSearchQuery = computed({
  get: () => activeTab.value === 'ledgers' ? ledgerSearchQuery.value : searchQuery.value,
  set: value => {
    if (activeTab.value === 'ledgers') ledgerSearchQuery.value = value;
    else searchQuery.value = value;
  }
});

const searchPlaceholder = computed(() => activeTab.value === 'ledgers'
  ? '搜索姓名、手机号、服务项目或备注…'
  : '姓名 / 手机号 / 手机尾号'
);
watch(headerSearchQuery, handleSearch, { flush: 'sync' });

const filteredLedgersList = computed(() => {
  const query = ledgerSearchQuery.value.trim().toLocaleLowerCase();
  if (!query) return ledgersList.value;
  const digits = query.replace(/\D/g, '');
  return ledgersList.value.filter(item => {
    const searchableText = [item.memberName, item.memberPhone, item.remark, getTypeText(item.type)]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    return searchableText.includes(query) || (digits && String(item.memberPhone || '').includes(digits));
  });
});

// 日期文本展示
const currentDate = ref(new Date());
const compactDateText = computed(() => `${currentDate.value.getMonth() + 1}/${String(currentDate.value.getDate()).padStart(2, '0')}`);
const currentDateText = computed(() => {
  const d = currentDate.value;
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${m}月${day}日 ${weekDays[d.getDay()]}`;
});

function formatCent(cent) {
  return ((cent || 0) / 100).toFixed(2);
}

// 格式化手机号：138 1234 5678 (易读)
function formatPhoneSpaced(phone) {
  const text = String(phone ?? '');
  if (text.length < 11) return text;
  return `${text.slice(0, 3)} ${text.slice(3, 7)} ${text.slice(7)}`;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const date = d.getDate().toString().padStart(2, '0');
  const h = d.getHours().toString().padStart(2, '0');
  const min = d.getMinutes().toString().padStart(2, '0');
  return `${m}-${date} ${h}:${min}`;
}

function getTypeText(type) {
  if (type === 'RECHARGE') return '储值入账';
  if (type === 'CONSUME') return '剪发扣款';
  if (type === 'REFUND') return '撤销冲正';
  return '流水';
}

function getBadgeClass(type) {
  if (type === 'RECHARGE') return 'bg-emerald-100 text-emerald-800';
  if (type === 'CONSUME') return 'bg-rose-100 text-rose-800';
  if (type === 'REFUND') return 'bg-amber-100 text-amber-800';
  return 'bg-slate-100 text-slate-800';
}

function showToast(msg) {
  clearTimeout(toastTimer);
  toastMessage.value = msg;
  toastTimer = setTimeout(() => {
    toastMessage.value = '';
  }, 2500);
}

function showFeedback(message, type = 'error', details = {}) {
  feedbackModal.value = {
    type,
    title: details.title || (type === 'success' ? '操作成功' : '操作未完成'),
    message,
    ...details
  };
}

// 刷新全量数据
function refreshAll() {
  currentDate.value = new Date();
  try {
    localDb.init();
    const nextMembers = localDb.getMembers(searchQuery.value);
    const nextDashboard = localDb.getDashboard();
    const nextServices = localDb.getServices();
    const nextPlans = localDb.getRechargePlans();
    const nextLedgers = localDb.getLedgers({ type: ledgerFilterType.value });
    membersList.value = nextMembers;
    customerLedgers.value = localDb.getLedgers();
    dashboard.value = nextDashboard;
    hairServices.value = nextServices;
    rechargePlans.value = nextPlans;
    ledgersList.value = nextLedgers;
    localSnapshots.value = localDb.getLocalSnapshots();
    if (selectedMember.value) selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    if (consumingMember.value) consumingMember.value = localDb.getMemberById(consumingMember.value.id);
    if (rechargingMember.value) rechargingMember.value = localDb.getMemberById(rechargingMember.value.id);
    storageError.value = '';
  } catch (error) {
    storageError.value = error.message;
    if (activeTab.value !== 'settings' || settingsPage.value === 'overview') openSettings('backup-files');
    membersList.value = [];
    customerLedgers.value = [];
    ledgersList.value = [];
    selectedMember.value = null;
    localSnapshots.value = localDb.getLocalSnapshots();
  }
}

function refreshLedgers() {
  ledgersList.value = localDb.getLedgers({ type: ledgerFilterType.value });
}

function handleSearch(event) {
  if (storageError.value || event?.target?.composing) return;
  if (event?.target && typeof event.target.value === 'string' && headerSearchQuery.value !== event.target.value) {
    headerSearchQuery.value = event.target.value;
    return;
  }
  try {
    if (activeTab.value === 'ledgers') refreshLedgers();
    else membersList.value = localDb.getMembers(searchQuery.value);
  } catch { refreshAll(); }
}

function clearSearch() {
  if (activeTab.value === 'ledgers') {
    ledgerSearchQuery.value = '';
  } else {
    searchQuery.value = '';
    membersList.value = localDb.getMembers();
  }
}

const currentMemberLedgers = computed(() => {
  if (!selectedMember.value) return [];
  return localDb.getLedgers({ memberId: selectedMember.value.id });
});

function selectMember(m) {
  const latest = localDb.getMemberById(m.id);
  selectedMember.value = latest || m;
}

// 充值
function openRechargeModal(m) {
  rechargingMember.value = localDb.getMemberById(m.id) || m;
  rechargeConfirmation.value = null;
  isSubmittingRecharge.value = false;
  rechargeForm.value = {
    actualPay: '',
    giftAmount: 0,
    payMethod: '微信支付',
    remark: ''
  };
}

function applyRechargePlan(plan) {
  rechargeForm.value.actualPay = plan.pay;
  rechargeForm.value.giftAmount = plan.gift;
}

const canSubmitRecharge = computed(() => {
  return isValidMoney(rechargeForm.value.actualPay) && Number(rechargeForm.value.actualPay) > 0 &&
    isValidMoney(rechargeForm.value.giftAmount === '' ? 0 : rechargeForm.value.giftAmount);
});

function requestRechargeConfirmation() {
  if (!rechargingMember.value || isSubmittingRecharge.value) return;
  if (!canSubmitRecharge.value) {
    showFeedback('请填写大于 0 的实收金额，赠送额度可以填写 0。');
    return;
  }

  const current = localDb.getMemberById(rechargingMember.value.id);
  if (!current) { showFeedback('客户不存在或已注销。'); return; }
  rechargingMember.value = current;
  const credit = moneyToCent(rechargeForm.value.actualPay) + moneyToCent(rechargeForm.value.giftAmount || 0);
  if (!Number.isSafeInteger(credit) || !Number.isSafeInteger(current.balance + credit)) {
    showFeedback('充值金额超出可处理范围。', 'error'); return;
  }
  rechargeConfirmation.value = {
    memberId: rechargingMember.value.id,
    memberName: rechargingMember.value.name,
    actualPay: Number(rechargeForm.value.actualPay),
    giftAmount: Number(rechargeForm.value.giftAmount),
    payMethod: rechargeForm.value.payMethod,
    remark: rechargeForm.value.remark,
    currentBalance: current.balance,
    balanceAfter: current.balance + credit,
    debtRepaid: Math.min(Math.max(0, -current.balance), credit)
  };
}

function confirmRecharge() {
  const confirmation = rechargeConfirmation.value;
  if (!confirmation || isSubmittingRecharge.value) return;
  const current = localDb.getMemberById(confirmation.memberId);
  if (!current || current.balance !== confirmation.currentBalance) {
    requestRechargeConfirmation();
    showToast('客户余额已变化，请重新核对充值结果。');
    return;
  }
  isSubmittingRecharge.value = true;

  try {
    const res = localDb.recharge({
      memberId: confirmation.memberId,
      actualPay: confirmation.actualPay,
      giftAmount: confirmation.giftAmount,
      payMethod: confirmation.payMethod,
      remark: confirmation.remark
    });

    const memberName = confirmation.memberName;
    const totalCredit = res.totalCredit / 100;
    const balanceAfter = (Math.abs(res.balanceAfter) / 100).toFixed(2);
    const balanceText = res.balanceAfter < 0 ? `当前仍欠款：¥${balanceAfter} 元，请后续结清。` : `当前可用余额：¥${balanceAfter} 元。`;
    const repaymentText = confirmation.debtRepaid > 0 ? `\n本次抵扣欠款：¥${formatCent(confirmation.debtRepaid)} 元` : '';

    rechargingMember.value = null;
    rechargeConfirmation.value = null;
    showToast('充值成功！');

    receiptModal.value = {
      name: memberName,
      messageText: `【梦飞空间会员充值通知】\n尊敬的 ${memberName}，您好！\n本次充值已成功入账：¥${totalCredit.toFixed(2)} 元${repaymentText}\n${balanceText}\n感谢您的支持与惠顾，祝您生活愉快！`
    };

    refreshAll();
    if (selectedMember.value) {
      selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    }
  } catch (err) {
    showFeedback(err.message, 'error', { title: '充值失败' });
  } finally {
    isSubmittingRecharge.value = false;
  }
}

// 扣款相关
function openConsumeModal(m) {
  consumingMember.value = localDb.getMemberById(m.id) || m;
  consumeConfirmation.value = null;
  isSubmittingConsume.value = false;
  const first = hairServices.value[0];
  consumeAmountStr.value = first ? first.price.toString() : '';
  consumeSummary.value = first ? first.name : '精致洗剪吹';
  showConsumeKeypad.value = false;
  debtAcknowledged.value = false;
}

function handleConsumeModalBack() {
  if (showConsumeKeypad.value) {
    showConsumeKeypad.value = false;
    return;
  }
  closeConsumeModal();
}

function closeConsumeModal() {
  consumingMember.value = null;
  consumeConfirmation.value = null;
}

function openConsumeKeypad() {
  showConsumeKeypad.value = true;
}

function clearConsumeAmount() {
  consumeAmountStr.value = '';
  showConsumeKeypad.value = true;
}

function setConsumePreset(item) {
  consumeAmountStr.value = item.price.toString();
  consumeSummary.value = item.name;
  showConsumeKeypad.value = false;
}

const consumeBalanceAfter = computed(() => {
  if (!consumingMember.value || !consumeAmountStr.value || !isValidMoney(consumeAmountStr.value)) return null;
  return consumingMember.value.balance - moneyToCent(consumeAmountStr.value);
});
const consumeDebtAdded = computed(() => consumeBalanceAfter.value === null ? 0
  : Math.max(0, -consumeBalanceAfter.value) - Math.max(0, -consumingMember.value.balance));
const isConsumeOverBalance = computed(() => {
  return canSubmitConsume.value && consumeBalanceAfter.value < 0;
});

const canSubmitConsume = computed(() => {
  if (!consumingMember.value) return false;
  if (!consumeAmountStr.value) return false;
  if (!isValidMoney(consumeAmountStr.value)) return false;
  const num = parseFloat(consumeAmountStr.value);
  if (num <= 0) return false;
  return Number.isSafeInteger(consumeBalanceAfter.value) && Number.isSafeInteger(consumingMember.value.total_consume + moneyToCent(consumeAmountStr.value));
});

function requestConsumeConfirmation() {
  if (!consumingMember.value || isSubmittingConsume.value) return;
  if (!consumeAmountStr.value || !isValidMoney(consumeAmountStr.value)) {
    showFeedback('请输入有效的扣款金额。');
    return;
  }
  const amountNum = parseFloat(consumeAmountStr.value);
  if (amountNum <= 0) {
    showFeedback('请输入大于 0 的有效扣款金额。');
    return;
  }
  const amountCent = moneyToCent(consumeAmountStr.value);
  const current = localDb.getMemberById(consumingMember.value.id);
  if (!current) { showFeedback('客户不存在或已注销。', 'error'); return; }
  consumingMember.value = current;
  if (!canSubmitConsume.value) { showFeedback('扣款金额超出可处理范围。', 'error'); return; }
  debtAcknowledged.value = false;

  consumeConfirmation.value = {
    memberId: consumingMember.value.id,
    memberName: consumingMember.value.name,
    memberPhone: consumingMember.value.phone,
    currentBalance: consumingMember.value.balance,
    amount: amountNum,
    amountCent,
    balanceAfter: consumingMember.value.balance - amountCent,
    debtAdded: consumeDebtAdded.value,
    itemsSummary: consumeSummary.value.trim() || '精致洗剪吹'
  };
}

function confirmConsume() {
  const conf = consumeConfirmation.value;
  if (!conf || isSubmittingConsume.value) return;
  if (conf.balanceAfter < 0 && !debtAcknowledged.value) return;
  const current = localDb.getMemberById(conf.memberId);
  if (!current) { consumeConfirmation.value = null; showFeedback('客户不存在或已注销。', 'error'); return; }
  if (current.balance !== conf.currentBalance) {
    requestConsumeConfirmation();
    showToast('客户余额已变化，请重新核对金额和欠款。');
    return;
  }
  isSubmittingConsume.value = true;
  try {
    const result = localDb.consume({
      memberId: conf.memberId,
      amount: conf.amount,
      itemsSummary: conf.itemsSummary,
      allowDebt: conf.balanceAfter < 0 && debtAcknowledged.value
    });

    const memberName = conf.memberName;
    const deductedCent = result.deductedAmount;
    const balanceAfterCent = result.balanceAfter;

    consumeConfirmation.value = null;
    consumingMember.value = null;

    refreshAll();
    if (selectedMember.value) {
      selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    }
    showFeedback(balanceAfterCent < 0 ? `本次已记录新增欠款 ¥${formatCent(conf.debtAdded)}，请记得收款结清。` : '本次服务已记入会员账本。', 'success', {
      title: balanceAfterCent < 0 ? '扣款成功 · 已记录欠款' : '消费成功',
      amount: (deductedCent / 100).toFixed(2),
      memberName,
      balance: (balanceAfterCent / 100).toFixed(2),
      debt: balanceAfterCent < 0 ? formatCent(-balanceAfterCent) : null
    });
  } catch (err) {
    showFeedback(err.message, 'error', { title: '扣款失败' });
  } finally {
    isSubmittingConsume.value = false;
  }
}

function rechargeFromConsume() {
  if (!consumingMember.value) return;
  const member = consumingMember.value;
  closeConsumeModal();
  openRechargeModal(member);
}

// 错单撤回 / 冲正
function confirmRefundLedger(item) {
  const amountYuan = Math.abs(item.changeAmount / 100).toFixed(2);
  const actionText = item.type === 'CONSUME' ? `撤销扣款并退还 ¥${amountYuan}` : `撤销充值并扣回 ¥${amountYuan}`;
  const current = localDb.getMemberById(item.memberId);
  const balanceAfter = (current?.balance || 0) - item.changeAmount;
  const debtWarning = balanceAfter < 0 ? `\n⚠️ 撤销后该客户累计欠款 ¥${formatCent(-balanceAfter)}，需后续收款结清。` : '';
  if (!confirm(`确定要为 ${item.memberName}${actionText}吗？系统将记录冲正流水。${debtWarning}`)) return;

  try {
    const res = localDb.refundLedger(item.id, '店主撤单冲正', balanceAfter < 0);
    showToast(`撤销成功，${res.newBalance < 0 ? '累计欠款' : '可用余额'} ¥${formatCent(Math.abs(res.newBalance))}`);
    refreshAll();
    if (selectedMember.value) {
      selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    }
  } catch (err) {
    showFeedback(err.message, 'error', { title: '撤销失败' });
  }
}

// 会员建卡与编辑
function openNewMemberModal() {
  editingMemberId.value = null;
  memberForm.value = {
    name: '',
    phone: '',
    initialBalance: 0,
    notes: ''
  };
  showMemberModal.value = true;
}

function openEditMemberModal(m) {
  editingMemberId.value = m.id;
  memberForm.value = {
    name: m.name,
    phone: m.phone,
    notes: m.notes || ''
  };
  showMemberModal.value = true;
}

function submitMemberForm() {
  if (isSavingMember.value) return;
  isSavingMember.value = true;
  try {
    if (editingMemberId.value) {
      const updated = localDb.updateMember(editingMemberId.value, memberForm.value);
      showMemberModal.value = false;
      showToast('会员档案修改成功！');
      refreshAll();
      selectMember(updated);
    } else {
      const created = localDb.createMember(memberForm.value);
      showMemberModal.value = false;
      showToast(`会员 ${created.name} 建档成功！`);
      refreshAll();
      selectMember(created);
    }
  } catch (err) {
    showFeedback(err.message);
  } finally {
    isSavingMember.value = false;
  }
}

function handleDeleteMember(m) {
  if (!confirm(`确定要注销会员「${m.name}」吗？历史档案和流水将保留用于对账。`)) return;
  try {
    localDb.deleteMember(m.id);
    selectedMember.value = null;
    showToast('会员档案已注销');
    refreshAll();
  } catch (err) {
    showFeedback(err.message);
  }
}

// 服务定价
function openAddServiceModal() {
  serviceForm.value = { id: '', name: '', price: 38 };
  showServiceModal.value = true;
}

function openEditServiceModal(s) {
  serviceForm.value = { id: s.id, name: s.name, price: s.price };
  showServiceModal.value = true;
}

function submitServiceForm() {
  if (isSavingService.value) return;
  isSavingService.value = true;
  try {
    localDb.saveService(serviceForm.value);
    showServiceModal.value = false;
    showToast('服务项目已更新');
    hairServices.value = localDb.getServices();
  } catch (err) {
    showFeedback(err.message);
  } finally {
    isSavingService.value = false;
  }
}

function deleteServiceItem(id) {
  if (!confirm('确定要删除该服务项目吗？')) return;
  hairServices.value = localDb.deleteService(id);
  showToast('服务项目已删除');
}

async function copyMemberField(text, label) {
  try { await copyToClipboard(text); showToast(label + '已复制'); }
  catch (error) { showToast(error.message || '复制失败，请重试'); }
}
async function copyReceiptText(text) {
  try { await copyToClipboard(text); showToast('已复制到剪贴板，可粘贴发给顾客微信'); }
  catch (error) { showToast(error.message || '复制失败，请重试'); }
}
function handleContextMenu(event) {
  if (!event.target.closest('input:not([type="file"]), textarea')) event.preventDefault();
}

// 微信/手机一键备份导出
async function handleExportBackup() {
  if (isExporting.value) return;
  isExporting.value = true;
  try {
    const recovery = localDb.readRecoveryState();
    if (recovery.dataError) {
      const result = await exportFile({
        content: JSON.stringify({ version: '2.0', exportedAt: new Date().toISOString(), appName: '梦飞空间会员管家', ...recovery }, null, 2),
        fileName: `梦飞空间账本原始数据_${new Date().toISOString().slice(0, 10)}.json`,
        mimeType: 'application/json', title: '账本原始数据备份'
      });
      showExportResult(result, '已导出原始数据，请保留文件并使用有效备份恢复账本。');
      return;
    }
    const content = localDb.exportBackupData({ archiveSnapshot: false });
    let snapshotWarning = '';
    try {
      localDb.saveLocalSnapshot('导出生成快照', '用户执行一键备份导出');
    } catch (error) {
      snapshotWarning = `本地快照未保存：${error.message}。`;
    }
    refreshAll();
    const dateStr = new Date().toISOString().split('T')[0];
    const result = await exportFile({ content, fileName: `梦飞空间会员账本备份_${dateStr}.json`,
      mimeType: 'application/json', title: '梦飞空间会员账本备份' });
    showExportResult(result, snapshotWarning);
  } catch (err) {
    if (!isExportCancelled(err)) {
      showFeedback(err.message, 'error', { title: '备份导出失败' });
    }
  } finally {
    isExporting.value = false;
  }
}

function showExportResult(result, extra = '') {
  const message = result.kind === 'shared'
    ? `已完成系统分享（${result.fileName}），请确认接收端文件可打开。`
    : `已发起文件下载（${result.fileName}），请在浏览器下载记录中确认保存结果。`;
  showFeedback(`${message}${extra}`, 'success', { title: '文件导出' });
}

async function handleExportCSV() {
  if (isExporting.value) return;
  isExporting.value = true;
  try {
    const csv = localDb.exportCSV();
    const dateStr = new Date().toISOString().split('T')[0];
    const result = await exportFile({ content: csv, fileName: `梦飞空间对账明细_${dateStr}.csv`,
      mimeType: 'text/csv;charset=utf-8', title: '梦飞空间对账明细' });
    showExportResult(result);
  } catch (err) {
    if (!isExportCancelled(err)) showFeedback(err.message, 'error', { title: '报表导出失败' });
  } finally {
    isExporting.value = false;
  }
}

// 手动创建本地快照
function handleCreateManualSnapshot() {
  try {
    localDb.saveLocalSnapshot('店主手动归档', '在设置备份页面点击立即归档');
    refreshAll();
    showToast('已在手机本地生成一份最新账本快照');
  } catch (err) {
    showFeedback(err.message, 'error', { title: '归档失败' });
  }
}

// 删除快照
function handleDeleteSnapshot(id) {
  if (!confirm('确定要删除此份本地快照记录吗？')) return;
  try {
    localDb.deleteLocalSnapshot(id);
    refreshAll();
    showToast('已删除此份本地快照');
  } catch (error) {
    showFeedback(error.message, 'error', { title: '删除快照失败' });
  }
}

// 分享/导出快照
async function handleShareSnapshot(s) {
  if (isExporting.value) return;
  isExporting.value = true;
  try {
    const result = await exportFile({ content: s.content, fileName: s.fileName,
      mimeType: 'application/json', title: '梦飞空间会员账本备份' });
    showExportResult(result);
  } catch (err) {
    if (!isExportCancelled(err)) {
      showFeedback(err.message, 'error', { title: '分享导出失败' });
    }
  } finally {
    isExporting.value = false;
  }
}

// 从快照快速触发恢复
function handleRestoreSnapshot(s, mode = 'merge') {
  try {
    const preview = localDb.previewBackup(s.content);
    restoreMode.value = preview.currentDataError ? 'replace' : mode;
    backupRestoreRequest.value = {
      content: s.content,
      fileName: s.fileName,
      preview
    };
  } catch (err) {
    showFeedback(err.message, 'error', { title: '读取快照失败' });
  }
}

// 从外部选文件恢复
function handleImportBackup(e) {
  const input = e.target;
  const file = input.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const content = String(event.target.result || '');
      const preview = localDb.previewBackup(content);
      restoreMode.value = preview.currentDataError ? 'replace' : 'merge';
      backupRestoreRequest.value = {
        content,
        fileName: file.name,
        preview
      };
    } catch (err) {
      showFeedback(err.message, 'error', { title: '备份校验失败' });
    } finally {
      input.value = '';
    }
  };
  reader.onerror = () => {
    input.value = '';
    showFeedback('无法读取所选文件，请重新选择备份文件。', 'error', { title: '备份读取失败' });
  };
  reader.readAsText(file);
}

// 确认执行恢复
function confirmBackupRestore() {
  const request = backupRestoreRequest.value;
  if (!request || isRestoringBackup.value) return;
  isRestoringBackup.value = true;
  try {
    const mode = restoreMode.value;
    if (mode === 'merge' && request.preview.mergeError) throw new Error(request.preview.mergeError);
    const result = localDb.importBackupData(request.content, { mode });
    backupRestoreRequest.value = null;
    selectedMember.value = null;
    consumingMember.value = null;
    rechargingMember.value = null;
    const recoveryMessage = cloudClient.snapshot().conflictReason === 'recovery' ? '本机账本已恢复，原待办已保留；请在云端设置中导出核对，再选择采用云端账本或确认上传恢复结果。' : '';
    const snapshotMessage = (result.snapshotSaved ? '已生成恢复后的本地快照。' : '恢复后的快照未能保存，请立即导出备份。') + recoveryMessage;
    refreshAll();
    if (result.mode === 'merge') {
      showFeedback(
        `已并入 ${result.newMembersAdded} 位新会员与 ${result.newLedgersAdded} 笔流水，同步 ${result.updatedMembers} 位会员的档案、余额与撤销状态。${snapshotMessage}`,
        'success',
        { title: '备份恢复成功' }
      );
    } else {
      showFeedback(`已全量恢复 ${result.count} 位会员及对应账本数据。${snapshotMessage}`, 'success', { title: '全量恢复完成' });
    }
  } catch (err) {
    showFeedback(err.message, 'error', { title: '备份恢复失败' });
  } finally {
    isRestoringBackup.value = false;
  }
}

let dailyRefreshTimer = null;
let appStateListener = null;
let backButtonListener = null;
let isUnmounted = false;
let stopCloud = null;
let exitPressCount = 0;
let exitResetTimer = null;
function resetExitSequence() {
  exitPressCount = 0;
  clearTimeout(exitResetTimer);
}
async function handleBackButton() {
  if (closeTopLayer()) { resetExitSequence(); return; }
  exitPressCount += 1;
  clearTimeout(exitResetTimer);
  if (exitPressCount >= 3) {
    resetExitSequence();
    try { await CapacitorApp.exitApp(); }
    catch { showToast('暂时无法退出，请重试'); }
    return;
  }
  showToast(exitPressCount === 1 ? '再按两次返回键退出应用' : '再按一次返回键退出应用');
  exitResetTimer = setTimeout(resetExitSequence, 2000);
}

function handleWindowKeydown(e) {
  if (e.key === 'Escape') {
    handleBackButton();
  }
}

function scheduleDailyRefresh() {
  clearTimeout(dailyRefreshTimer);
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  dailyRefreshTimer = setTimeout(refreshOnResume, midnight.getTime() - now.getTime());
}

function refreshOnResume() {
  if (isUnmounted) return;
  refreshAll();
  scheduleDailyRefresh();
  cloudClient.sync().catch(() => {});
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') refreshOnResume();
}

function closeTopLayer() {
  if (feedbackModal.value) { feedbackModal.value = null; return true; }
  if (receiptModal.value) { receiptModal.value = null; return true; }
  if (backupRestoreRequest.value) { backupRestoreRequest.value = null; return true; }
  if (showServiceModal.value) { showServiceModal.value = false; return true; }
  if (showMemberModal.value) { showMemberModal.value = false; return true; }
  if (consumeConfirmation.value) { consumeConfirmation.value = null; return true; }
  if (rechargeConfirmation.value) { rechargeConfirmation.value = null; return true; }
  if (rechargingMember.value) { rechargingMember.value = null; return true; }
  if (consumingMember.value) {
    if (showConsumeKeypad.value) {
      showConsumeKeypad.value = false;
      return true;
    }
    closeConsumeModal();
    return true;
  }
  if (selectedMember.value) { selectedMember.value = null; return true; }
  if (activeTab.value === 'settings' && settingsPath.value.length && !cloudLocked.value) { backInSettings(); return true; }
  if (activeTab.value !== 'customers' && !cloudLocked.value) { activeTab.value = 'customers'; return true; }
  return false;
}

onMounted(async () => {
  refreshAll();
  scheduleDailyRefresh();
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', refreshOnResume);
  window.addEventListener('cloud-data-updated', refreshAll);
  window.addEventListener('keydown', handleWindowKeydown);
  cloudClient.start().then(stop => { if (isUnmounted) stop(); else stopCloud = stop; }).catch(error => showFeedback(error.message, 'error', { title: '云端连接未启动' }));
  if (isNativeApp) {
    try {
      const listener = await CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) refreshOnResume();
      });
      if (isUnmounted) { await listener.remove(); return; }
      appStateListener = listener;
    } catch (error) {
      console.warn('应用状态监听未能启动:', error);
    }
    try {
      const backListener = await CapacitorApp.addListener('backButton', handleBackButton);
      if (isUnmounted) await backListener.remove();
      else backButtonListener = backListener;
    } catch (error) {
      console.warn('返回键监听未能启动:', error);
    }
  }
});

onUnmounted(() => {
  isUnmounted = true;
  resetExitSequence();
  clearTimeout(toastTimer);
  clearTimeout(dailyRefreshTimer);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  window.removeEventListener('focus', refreshOnResume);
  window.removeEventListener('cloud-data-updated', refreshAll);
  window.removeEventListener('keydown', handleWindowKeydown);
  stopCloud?.(); stopCloudSubscription();
  appStateListener?.remove().catch(error => console.warn('应用状态监听清理失败:', error));
  backButtonListener?.remove().catch(error => console.warn('返回键监听清理失败:', error));
});
</script>
