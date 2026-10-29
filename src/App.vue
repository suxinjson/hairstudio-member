<template>
  <div class="flex flex-col min-h-screen bg-slate-100 text-slate-800 pb-20 select-none">
    
    <!-- 顶部状态栏与标题 -->
    <header class="bg-gradient-to-r from-slate-900 to-indigo-950 text-white p-4 pt-safe sticky top-0 z-30 shadow-md">
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-2">
          <div class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-lg shadow">
            ✂️
          </div>
          <div>
            <h1 class="text-base font-bold tracking-tight">理发店会员额度管家</h1>
            <p class="text-xs text-indigo-300">纯单机免服务器 · 离线秒开 · 微信安全备份</p>
          </div>
        </div>

        <button 
          @click="openNewMemberModal"
          class="flex items-center space-x-1 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded-full font-medium shadow transition btn-press"
        >
          <span>+ 登记新会员</span>
        </button>
      </div>

      <!-- 快速搜索框 -->
      <div class="mt-3 relative">
        <input 
          v-model="searchQuery" 
          @input="handleSearch"
          type="text" 
          placeholder="报手机尾号或姓名，秒查会员..." 
          class="w-full bg-slate-800/90 border border-slate-700 text-white text-sm rounded-xl pl-9 pr-8 py-2.5 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
        />
        <span class="absolute left-3 top-2.5 text-slate-400">🔍</span>
        <button 
          v-if="searchQuery" 
          @click="clearSearch"
          class="absolute right-3 top-2.5 text-slate-400 hover:text-white text-sm"
        >
          ✕
        </button>
      </div>
    </header>

    <!-- 主视口内容 -->
    <main class="flex-1 p-3">
      
      <!-- TAB 1: 工作台 / 概览 -->
      <div v-if="activeTab === 'home'" class="space-y-4">
        <!-- 今日营业收银卡片 -->
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-200">
          <div class="flex items-center justify-between pb-2 border-b border-slate-100">
            <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">今日小店收支简报</span>
            <span class="text-[11px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full font-medium">● 单机已就绪</span>
          </div>

          <div class="grid grid-cols-2 gap-3 mt-3">
            <div class="bg-emerald-50/80 p-3 rounded-xl border border-emerald-100">
              <div class="text-xs text-emerald-800 font-medium">今日储值充值</div>
              <div class="text-xl font-bold text-emerald-700 tabular-nums mt-1">
                ¥ {{ formatCent(dashboard.today?.rechargeCreditTotal || 0) }}
              </div>
              <div class="text-[11px] text-emerald-600/90 mt-0.5">
                入账 {{ dashboard.today?.rechargeCount || 0 }} 笔
              </div>
            </div>

            <div class="bg-rose-50/80 p-3 rounded-xl border border-rose-100">
              <div class="text-xs text-rose-800 font-medium">今日剪发扣额</div>
              <div class="text-xl font-bold text-rose-700 tabular-nums mt-1">
                ¥ {{ formatCent(dashboard.today?.consumeAmount || 0) }}
              </div>
              <div class="text-[11px] text-rose-600/90 mt-0.5">
                到店消费 {{ dashboard.today?.consumeCount || 0 }} 人次
              </div>
            </div>
          </div>

          <!-- 系统资金沉淀与总数 -->
          <div class="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-slate-100 text-xs text-slate-600">
            <div>
              <span class="text-slate-400">会员总沉淀余额：</span>
              <span class="font-bold text-slate-800 tabular-nums">¥ {{ formatCent(dashboard.totalBalance || 0) }}</span>
            </div>
            <div>
              <span class="text-slate-400">会员总人数：</span>
              <span class="font-bold text-slate-800 tabular-nums">{{ dashboard.memberCount || 0 }} 人</span>
            </div>
          </div>
        </div>

        <!-- 快捷入口 -->
        <div class="grid grid-cols-2 gap-3">
          <button 
            @click="activeTab = 'members'"
            class="flex items-center space-x-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm text-left btn-press"
          >
            <div class="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center text-xl">
              👥
            </div>
            <div>
              <div class="font-bold text-sm text-slate-800">全部会员名册</div>
              <div class="text-xs text-slate-500">查余额 · 充值扣费</div>
            </div>
          </button>

          <button 
            @click="activeTab = 'backup'"
            class="flex items-center space-x-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm text-left btn-press"
          >
            <div class="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center text-xl">
              📤
            </div>
            <div>
              <div class="font-bold text-sm text-slate-800">备份与导出</div>
              <div class="text-xs text-slate-500">发到微信 · Excel</div>
            </div>
          </button>
        </div>

        <!-- 会员列表 -->
        <div>
          <div class="flex items-center justify-between mb-2 px-1">
            <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500">
              {{ searchQuery ? `搜索匹配 (${membersList.length})` : '最近来店客户' }}
            </h2>
            <span class="text-xs text-slate-400">点击客户即刻充值/扣款</span>
          </div>

          <div v-if="membersList.length === 0" class="bg-white rounded-2xl p-8 text-center border border-slate-200">
            <div class="text-4xl mb-2">🔍</div>
            <p class="text-sm font-medium text-slate-600">未找到此手机号或姓名</p>
            <p class="text-xs text-slate-400 mt-1">可直接为新顾客登记建档</p>
            <button 
              @click="openNewMemberModal" 
              class="mt-3 bg-indigo-600 text-white text-xs px-4 py-2 rounded-lg font-medium shadow btn-press"
            >
              + 立即建档录入
            </button>
          </div>

          <div v-else class="space-y-2">
            <div 
              v-for="m in membersList" 
              :key="m.id"
              @click="selectMember(m)"
              class="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between active:bg-slate-50 transition cursor-pointer"
            >
              <div class="flex items-center space-x-3">
                <div class="w-11 h-11 rounded-full bg-slate-800 text-white flex items-center justify-center font-bold text-base shadow-sm">
                  {{ m.name.charAt(0) }}
                </div>
                <div>
                  <div class="flex items-center space-x-2">
                    <span class="font-bold text-slate-900 text-sm">{{ m.name }}</span>
                    <span v-if="m.notes" class="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                      {{ m.notes }}
                    </span>
                  </div>
                  <div class="text-xs text-slate-400 tracking-wider font-mono mt-0.5">{{ formatPhone(m.phone) }}</div>
                </div>
              </div>

              <div class="text-right">
                <div class="text-xs text-slate-400">可用余额</div>
                <div class="text-base font-bold text-indigo-600 tabular-nums">
                  ¥ {{ formatCent(m.balance) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 2: 会员名册 -->
      <div v-if="activeTab === 'members'" class="space-y-3">
        <div class="flex items-center justify-between px-1">
          <span class="text-xs text-slate-500 font-semibold">共 {{ membersList.length }} 位客户</span>
          <div class="text-xs text-slate-400">点击查看充值消费明细</div>
        </div>

        <div class="space-y-2">
          <div 
            v-for="m in membersList" 
            :key="m.id"
            @click="selectMember(m)"
            class="bg-white p-3.5 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between active:bg-slate-50 cursor-pointer"
          >
            <div class="flex items-center space-x-3">
              <div class="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center font-bold text-sm">
                {{ m.name.charAt(0) }}
              </div>
              <div>
                <div class="font-bold text-slate-900 text-sm">{{ m.name }}</div>
                <div class="text-xs text-slate-500 font-mono">{{ formatPhone(m.phone) }}</div>
              </div>
            </div>
            <div class="text-right">
              <div class="text-base font-bold text-slate-900 tabular-nums">¥ {{ formatCent(m.balance) }}</div>
              <div class="text-[11px] text-slate-400">累计消费 ¥{{ formatCent(m.total_consume) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 3: 流水明细 -->
      <div v-if="activeTab === 'ledgers'" class="space-y-3">
        <div class="flex space-x-2 bg-slate-200/70 p-1 rounded-xl text-xs font-medium">
          <button 
            v-for="type in [{ key: '', label: '全部流水' }, { key: 'CONSUME', label: '剪发扣费' }, { key: 'RECHARGE', label: '储值入账' }]"
            :key="type.key"
            @click="ledgerFilterType = type.key; refreshLedgers()"
            class="flex-1 py-1.5 rounded-lg transition"
            :class="ledgerFilterType === type.key ? 'bg-white text-slate-900 font-bold shadow-sm' : 'text-slate-600'"
          >
            {{ type.label }}
          </button>
        </div>

        <div v-if="ledgersList.length === 0" class="bg-white rounded-2xl p-8 text-center border border-slate-200 text-slate-400 text-sm">
          暂无流水账单
        </div>
        <div v-else class="space-y-2">
          <div 
            v-for="item in ledgersList" 
            :key="item.id"
            class="bg-white p-3 rounded-xl border border-slate-200 shadow-sm text-xs"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-2">
                <span 
                  class="px-2 py-0.5 rounded-md font-bold text-[11px]"
                  :class="item.type === 'RECHARGE' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'"
                >
                  {{ item.type === 'RECHARGE' ? '充值入账' : '消费扣减' }}
                </span>
                <span class="font-bold text-slate-800 text-sm">{{ item.memberName }}</span>
                <span class="text-slate-400 font-mono">{{ formatPhone(item.memberPhone) }}</span>
              </div>
              <div 
                class="text-sm font-bold tabular-nums"
                :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
              >
                {{ item.changeAmount > 0 ? '+' : '' }}{{ (item.changeAmount / 100).toFixed(2) }} 元
              </div>
            </div>

            <div class="mt-2 flex items-center justify-between text-slate-500 pt-1 border-t border-slate-100 text-[11px]">
              <div class="truncate max-w-[200px] text-slate-600">
                {{ item.remark || '无项目说明' }}
              </div>
              <div>
                扣后余额: ¥{{ (item.balanceAfter / 100).toFixed(2) }}
              </div>
            </div>

            <div class="flex items-center justify-end text-slate-400 text-[10px] mt-1">
              <span>{{ formatTime(item.created_at) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- TAB 4: 微信备份 & 导出安全中心 -->
      <div v-if="activeTab === 'backup'" class="space-y-4">
        <div class="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
          <div class="flex items-center space-x-2 mb-2">
            <span class="text-xl">🛡️</span>
            <div>
              <h2 class="font-bold text-slate-900 text-sm">单机数据安全与微信备份</h2>
              <p class="text-xs text-slate-400">不用云服务器，数据存在手机里，换机也不怕丢</p>
            </div>
          </div>

          <div class="space-y-3 mt-4">
            <!-- 导出备份 -->
            <button 
              @click="handleExportBackup"
              class="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white p-3.5 rounded-xl font-bold text-xs flex items-center justify-between shadow btn-press"
            >
              <div class="flex items-center space-x-2">
                <span class="text-lg">📤</span>
                <div class="text-left">
                  <div>一键备份所有账本 (发送至微信)</div>
                  <div class="text-[10px] text-emerald-100 font-normal">生成加密备份文件，可发给微信文件传输助手永久保存</div>
                </div>
              </div>
              <span>›</span>
            </button>

            <!-- 导出 Excel 表格 -->
            <button 
              @click="handleExportCSV"
              class="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white p-3.5 rounded-xl font-bold text-xs flex items-center justify-between shadow btn-press"
            >
              <div class="flex items-center space-x-2">
                <span class="text-lg">📊</span>
                <div class="text-left">
                  <div>导出 Excel 对账报表 (.csv)</div>
                  <div class="text-[10px] text-blue-100 font-normal">方便用手机 WPS 或电脑 Excel 打开核算</div>
                </div>
              </div>
              <span>›</span>
            </button>

            <!-- 恢复备份 -->
            <div class="pt-2 border-t border-slate-100">
              <label class="w-full bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 p-3.5 rounded-xl font-bold text-xs flex items-center justify-between border border-slate-200 cursor-pointer">
                <div class="flex items-center space-x-2">
                  <span class="text-lg">📥</span>
                  <div class="text-left">
                    <div>从微信/手机备份文件恢复数据</div>
                    <div class="text-[10px] text-slate-400 font-normal">换新手机或误删时，选中之前备份的文件即可1秒还原</div>
                  </div>
                </div>
                <span>选择文件</span>
                <input type="file" accept=".json" @change="handleImportBackup" class="hidden" />
              </label>
            </div>
          </div>
        </div>

        <div class="bg-indigo-50/70 p-4 rounded-2xl border border-indigo-100 text-xs text-indigo-900 leading-relaxed space-y-2">
          <div class="font-bold flex items-center space-x-1">
            <span>💡</span>
            <span>店主日常使用小建议：</span>
          </div>
          <p>1. 本 App 是<strong>完全本地单机运行</strong>，店里 WiFi 断网也能正常扣费记账，完全不消耗流量。</p>
          <p>2. 建议<strong>每周日打烊时</strong>，顺手点一下「一键备份所有账本」，发一份到微信“文件传输助手”或微信群里，换新手机时随时导入，双重保险最安心！</p>
        </div>
      </div>

    </main>

    <!-- 底部固定导航栏 -->
    <nav class="fixed bottom-0 left-0 right-0 max-w-[460px] mx-auto bg-white/95 backdrop-blur-md border-t border-slate-200 z-30 pb-safe shadow-lg">
      <div class="grid grid-cols-4 h-14">
        <button 
          @click="activeTab = 'home'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'home' ? 'text-indigo-600 font-bold' : 'text-slate-400'"
        >
          <span class="text-lg">🏪</span>
          <span class="text-[10px] mt-0.5">收银台</span>
        </button>

        <button 
          @click="activeTab = 'members'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'members' ? 'text-indigo-600 font-bold' : 'text-slate-400'"
        >
          <span class="text-lg">👥</span>
          <span class="text-[10px] mt-0.5">会员库</span>
        </button>

        <button 
          @click="activeTab = 'ledgers'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'ledgers' ? 'text-indigo-600 font-bold' : 'text-slate-400'"
        >
          <span class="text-lg">📋</span>
          <span class="text-[10px] mt-0.5">账单流水</span>
        </button>

        <button 
          @click="activeTab = 'backup'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'backup' ? 'text-indigo-600 font-bold' : 'text-slate-400'"
        >
          <span class="text-lg">🛡️</span>
          <span class="text-[10px] mt-0.5">备份对账</span>
        </button>
      </div>
    </nav>

    <!-- ================== 弹窗/抽屉层 ================== -->

    <!-- 1. 会员详情与收银面板 -->
    <div 
      v-if="selectedMember" 
      class="fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in"
      @click.self="selectedMember = null"
    >
      <div class="bg-white rounded-t-3xl max-h-[90vh] flex flex-col animate-slide-up shadow-2xl max-w-[460px] mx-auto w-full">
        <!-- 弹窗顶栏 -->
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <div class="w-10 h-10 rounded-full bg-slate-800 text-white flex items-center justify-center font-bold text-base">
              {{ selectedMember.name.charAt(0) }}
            </div>
            <div>
              <div class="flex items-center space-x-2">
                <h3 class="font-bold text-base text-slate-900">{{ selectedMember.name }}</h3>
                <span class="text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-medium">储值客户</span>
              </div>
              <div class="text-xs text-slate-400 font-mono tracking-wider">{{ formatPhone(selectedMember.phone) }}</div>
            </div>
          </div>
          <button 
            @click="selectedMember = null" 
            class="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-sm font-bold active:bg-slate-200"
          >
            ✕
          </button>
        </div>

        <!-- 内容滚动区 -->
        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <!-- 核心额度大卡片 -->
          <div class="bg-gradient-to-br from-indigo-700 to-purple-800 rounded-2xl p-5 text-white shadow-md relative overflow-hidden">
            <div class="text-xs text-indigo-200 font-medium">当前卡内可用额度</div>
            <div class="text-4xl font-extrabold tracking-tight mt-1 tabular-nums">
              ¥ {{ formatCent(selectedMember.balance) }}
            </div>

            <div class="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-indigo-500/40 text-xs">
              <div>
                <span class="text-indigo-200">累计充值：</span>
                <span class="font-bold tabular-nums">¥{{ formatCent(selectedMember.total_recharge) }}</span>
              </div>
              <div>
                <span class="text-indigo-200">累计消费：</span>
                <span class="font-bold tabular-nums">¥{{ formatCent(selectedMember.total_consume) }}</span>
              </div>
            </div>
          </div>

          <!-- 会员备注/档案 -->
          <div v-if="selectedMember.notes" class="bg-amber-50 p-3 rounded-xl border border-amber-200 text-xs text-amber-800">
            <strong>发型/习惯偏好：</strong> {{ selectedMember.notes }}
          </div>

          <!-- 该会员的历史流水 -->
          <div>
            <div class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              近期消费与充值记录 ({{ currentMemberLedgers.length }})
            </div>

            <div v-if="currentMemberLedgers.length === 0" class="text-xs text-slate-400 py-4 text-center">
              暂无记录
            </div>
            <div v-else class="space-y-2">
              <div 
                v-for="l in currentMemberLedgers" 
                :key="l.id"
                class="bg-slate-50 p-3 rounded-xl border border-slate-200 flex items-center justify-between text-xs"
              >
                <div>
                  <div class="flex items-center space-x-2">
                    <span 
                      class="px-1.5 py-0.5 rounded text-[10px] font-bold"
                      :class="l.type === 'RECHARGE' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'"
                    >
                      {{ l.type === 'RECHARGE' ? '充值' : '扣费' }}
                    </span>
                    <span class="font-medium text-slate-800">{{ l.remark || '无' }}</span>
                  </div>
                  <div class="text-[10px] text-slate-400 mt-1">
                    {{ formatTime(l.created_at) }}
                  </div>
                </div>

                <div class="text-right">
                  <div 
                    class="font-bold tabular-nums text-sm"
                    :class="l.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
                  >
                    {{ l.changeAmount > 0 ? '+' : '' }}{{ (l.changeAmount / 100).toFixed(2) }}
                  </div>
                  <div class="text-[10px] text-slate-400">
                    余额: ¥{{ (l.balanceAfter / 100).toFixed(2) }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部核心两项操作按钮 (拇指热区) -->
        <div class="p-4 border-t border-slate-200 bg-white grid grid-cols-2 gap-3 pb-safe">
          <button 
            @click="openRechargeModal(selectedMember)"
            class="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white py-3.5 rounded-xl font-bold text-sm shadow-md flex items-center justify-center space-x-1 btn-press"
          >
            <span>💳 会员充值</span>
          </button>

          <button 
            @click="openConsumeModal(selectedMember)"
            class="bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white py-3.5 rounded-xl font-bold text-sm shadow-md flex items-center justify-center space-x-1 btn-press"
          >
            <span>✂️ 剪发扣款</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 2. 剪发消费扣款抽屉 (含数字键盘) -->
    <div 
      v-if="consumingMember" 
      class="fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in"
      @click.self="consumingMember = null"
    >
      <div class="bg-white rounded-t-3xl flex flex-col animate-slide-up shadow-2xl max-w-[460px] mx-auto w-full">
        <div class="p-3.5 border-b border-slate-100 flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span class="text-lg">✂️</span>
            <div>
              <div class="font-bold text-sm text-slate-800">
                剪发扣款 - {{ consumingMember.name }}
              </div>
              <div class="text-xs text-slate-400">
                卡内余额: <span class="font-bold text-indigo-600">¥ {{ formatCent(consumingMember.balance) }}</span>
              </div>
            </div>
          </div>
          <button @click="consumingMember = null" class="text-slate-400 hover:text-slate-700 text-lg p-1">✕</button>
        </div>

        <!-- 金额展示区 -->
        <div class="p-4 bg-slate-50 text-center border-b border-slate-200">
          <div class="text-xs text-slate-400">扣款金额 (元)</div>
          <div class="text-4xl font-extrabold text-slate-900 tracking-tight tabular-nums mt-1 flex items-center justify-center">
            <span class="text-2xl mr-1 text-slate-400">¥</span>
            <span>{{ consumeAmountStr || '0.00' }}</span>
          </div>

          <div v-if="isConsumeOverBalance" class="text-xs text-red-600 font-bold mt-1 bg-red-50 py-1 px-2 rounded-lg inline-block">
            ⚠️ 扣款金额超过当前可用余额！
          </div>
        </div>

        <!-- 理发店快捷服务标签 -->
        <div class="p-3 bg-white border-b border-slate-100">
          <div class="text-[11px] text-slate-400 mb-1.5 font-medium">点击快速带入常用服务项目：</div>
          <div class="flex flex-wrap gap-1.5">
            <button 
              v-for="item in hairServices" 
              :key="item.id"
              @click="setConsumePreset(item)"
              class="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 active:bg-indigo-50 active:border-indigo-400 text-slate-700"
            >
              {{ item.name }} (¥{{ item.price }})
            </button>
          </div>

          <!-- 手动输入备注 -->
          <div class="mt-2">
            <input 
              v-model="consumeSummary" 
              type="text" 
              placeholder="项目备注（如：洗剪吹 + 护发素）..." 
              class="w-full text-xs p-2 bg-slate-100 rounded-lg border-0 focus:ring-1 focus:ring-indigo-500 outline-none"
            />
          </div>
        </div>

        <!-- 移动端大按键数字键盘 -->
        <Keypad 
          v-model="consumeAmountStr" 
          confirmText="确认扣除" 
          theme="danger"
          :disabled="isConsumeOverBalance"
          @confirm="submitConsume" 
        />
      </div>
    </div>

    <!-- 3. 储值充值抽屉 -->
    <div 
      v-if="rechargingMember" 
      class="fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in"
      @click.self="rechargingMember = null"
    >
      <div class="bg-white rounded-t-3xl max-h-[92vh] flex flex-col animate-slide-up shadow-2xl max-w-[460px] mx-auto w-full">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div class="font-bold text-base text-slate-800">
              额度充值 - {{ rechargingMember.name }}
            </div>
            <div class="text-xs text-slate-400">
              当前卡内余额: ¥{{ formatCent(rechargingMember.balance) }}
            </div>
          </div>
          <button @click="rechargingMember = null" class="text-slate-400 hover:text-slate-700 text-lg">✕</button>
        </div>

        <div class="p-4 overflow-y-auto space-y-4">
          <!-- 快捷充值档位 -->
          <div>
            <div class="text-xs font-bold text-slate-500 mb-2">快捷充值套餐</div>
            <div class="grid grid-cols-3 gap-2">
              <button 
                v-for="plan in rechargePlans" 
                :key="plan.pay"
                @click="applyRechargePlan(plan)"
                class="p-2.5 rounded-xl border text-center transition btn-press"
                :class="rechargeForm.actualPay == plan.pay && rechargeForm.giftAmount == plan.gift ? 'border-emerald-600 bg-emerald-50 text-emerald-800 font-bold' : 'border-slate-200 bg-slate-50 text-slate-700'"
              >
                <div class="text-sm font-bold">充¥{{ plan.pay }}</div>
                <div class="text-[10px] text-emerald-600 mt-0.5">
                  {{ plan.gift > 0 ? `送¥${plan.gift}` : '到账¥' + plan.pay }}
                </div>
              </button>
            </div>
          </div>

          <!-- 自定义实付与赠送 -->
          <div class="space-y-3 bg-slate-50 p-3.5 rounded-xl border border-slate-200">
            <div>
              <label class="text-xs font-bold text-slate-600 block mb-1">实收充值金额 (元)</label>
              <input 
                v-model.number="rechargeForm.actualPay" 
                type="number" 
                step="0.01" 
                placeholder="0.00"
                class="w-full bg-white p-2.5 text-base font-bold text-slate-900 rounded-lg border border-slate-300 outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label class="text-xs font-bold text-slate-600 block mb-1">额外赠送额度 (元，可填0)</label>
              <input 
                v-model.number="rechargeForm.giftAmount" 
                type="number" 
                step="0.01" 
                placeholder="0.00"
                class="w-full bg-white p-2.5 text-base font-bold text-emerald-600 rounded-lg border border-slate-300 outline-none focus:border-emerald-500"
              />
            </div>

            <div class="pt-2 border-t border-slate-200 flex justify-between text-xs">
              <span class="text-slate-500">卡内总入账额度：</span>
              <span class="font-extrabold text-emerald-600 text-sm">
                ¥ {{ ((Number(rechargeForm.actualPay || 0) + Number(rechargeForm.giftAmount || 0))).toFixed(2) }}
              </span>
            </div>
          </div>

          <!-- 收款渠道 -->
          <div>
            <div class="text-xs font-bold text-slate-500 mb-2">收款方式</div>
            <div class="grid grid-cols-4 gap-2 text-xs">
              <button 
                v-for="m in ['微信支付', '支付宝', '现金收款', '其他方式']"
                :key="m"
                @click="rechargeForm.payMethod = m"
                class="p-2 rounded-lg border text-center transition"
                :class="rechargeForm.payMethod === m ? 'border-emerald-600 bg-emerald-50 text-emerald-800 font-bold' : 'border-slate-200 text-slate-600'"
              >
                {{ m }}
              </button>
            </div>
          </div>

          <div>
            <label class="text-xs font-bold text-slate-500 block mb-1">充值备注 (选填)</label>
            <input 
              v-model="rechargeForm.remark" 
              type="text" 
              placeholder="例：老顾客活动充值" 
              class="w-full text-xs p-2.5 bg-slate-50 rounded-lg border border-slate-200 outline-none"
            />
          </div>
        </div>

        <div class="p-4 border-t border-slate-100 bg-white pb-safe">
          <button 
            @click="submitRecharge"
            :disabled="!(rechargeForm.actualPay > 0 || rechargeForm.giftAmount > 0)"
            class="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-300 text-white py-3.5 rounded-xl font-bold text-sm shadow-md btn-press"
          >
            确认完成充值
          </button>
        </div>
      </div>
    </div>

    <!-- 4. 新建会员弹窗 -->
    <div 
      v-if="showNewMemberModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
      @click.self="showNewMemberModal = false"
    >
      <div class="bg-white rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
        <div class="flex items-center justify-between border-b pb-2">
          <h3 class="font-bold text-base text-slate-900">登记新会员档案</h3>
          <button @click="showNewMemberModal = false" class="text-slate-400">✕</button>
        </div>

        <div class="space-y-3 text-xs">
          <div>
            <label class="font-bold text-slate-700 block mb-1">客户姓名 <span class="text-red-500">*</span></label>
            <input 
              v-model="newMemberForm.name" 
              type="text" 
              placeholder="如：张姐 / 8号熟客" 
              class="w-full p-2.5 border rounded-lg outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label class="font-bold text-slate-700 block mb-1">手机号码 <span class="text-red-500">*</span></label>
            <input 
              v-model="newMemberForm.phone" 
              type="tel" 
              placeholder="报手机尾号查找的依据" 
              class="w-full p-2.5 border rounded-lg outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label class="font-bold text-slate-700 block mb-1">开卡初始储值额 (元，可填0)</label>
            <input 
              v-model.number="newMemberForm.initialBalance" 
              type="number" 
              step="0.01" 
              placeholder="0.00" 
              class="w-full p-2.5 border rounded-lg outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label class="font-bold text-slate-700 block mb-1">发型与习惯偏好备注</label>
            <textarea 
              v-model="newMemberForm.notes" 
              rows="2" 
              placeholder="如：喜欢短发寸头、染发用栗棕色、不喜欢推子太贴皮等" 
              class="w-full p-2 border rounded-lg outline-none focus:border-indigo-500 resize-none"
            ></textarea>
          </div>
        </div>

        <div class="flex space-x-2 pt-2">
          <button 
            @click="showNewMemberModal = false"
            class="flex-1 py-2.5 rounded-xl border border-slate-300 text-xs font-bold text-slate-600"
          >
            取消
          </button>
          <button 
            @click="submitCreateMember"
            :disabled="!newMemberForm.name || !newMemberForm.phone"
            class="flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-300 text-xs font-bold text-white shadow"
          >
            确认建档
          </button>
        </div>
      </div>
    </div>

    <!-- 5. 微信致谢通知卡片 -->
    <div 
      v-if="receiptModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
      @click.self="receiptModal = null"
    >
      <div class="bg-white rounded-2xl max-w-sm w-full p-5 space-y-3 shadow-2xl text-center">
        <div class="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto text-2xl">
          ✓
        </div>
        <h3 class="font-bold text-slate-900 text-base">充值入账成功</h3>
        <p class="text-xs text-slate-500">已为会员 {{ receiptModal.name }} 存入额度</p>

        <!-- 通知文案框 -->
        <div class="bg-slate-50 p-3 rounded-xl border border-slate-200 text-left text-xs text-slate-700 leading-relaxed font-mono select-all">
          {{ receiptModal.messageText }}
        </div>

        <button 
          @click="copyReceiptText(receiptModal.messageText)"
          class="w-full py-2.5 bg-indigo-600 text-white rounded-xl text-xs font-bold shadow active:bg-indigo-700"
        >
          📋 一键复制致谢文案 (微信发给顾客)
        </button>

        <button 
          @click="receiptModal = null"
          class="w-full py-2 text-slate-400 text-xs"
        >
          关闭
        </button>
      </div>
    </div>

    <!-- 浮动 Toast 消息通知 -->
    <div 
      v-if="toastMessage" 
      class="fixed top-20 left-1/2 -translate-x-1/2 bg-slate-900/90 backdrop-blur-md text-white text-xs px-4 py-2.5 rounded-full shadow-xl z-50 animate-fade-in flex items-center space-x-1.5"
    >
      <span>ℹ️</span>
      <span>{{ toastMessage }}</span>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { localDb, DEFAULT_SERVICES, DEFAULT_RECHARGE_PLANS } from './storage.js';
import Keypad from './components/Keypad.vue';

// 页面标签：'home' | 'members' | 'ledgers' | 'backup'
const activeTab = ref('home');

// 全局状态
const dashboard = ref({});
const membersList = ref([]);
const ledgersList = ref([]);
const searchQuery = ref('');
const toastMessage = ref('');

// 模态弹窗状态
const selectedMember = ref(null);

const consumingMember = ref(null);
const consumeAmountStr = ref('');
const consumeSummary = ref('精致洗剪吹');

const rechargingMember = ref(null);
const rechargeForm = ref({
  actualPay: 300,
  giftAmount: 40,
  payMethod: '微信支付',
  remark: ''
});

const showNewMemberModal = ref(false);
const newMemberForm = ref({
  name: '',
  phone: '',
  initialBalance: 0,
  notes: ''
});

const receiptModal = ref(null);
const ledgerFilterType = ref('');

// 理发店快捷服务与充值套餐
const hairServices = ref(DEFAULT_SERVICES);
const rechargePlans = ref(DEFAULT_RECHARGE_PLANS);

// 辅助方法：分转元
function formatCent(cent) {
  return ((cent || 0) / 100).toFixed(2);
}

function formatPhone(phone) {
  if (!phone || phone.length < 7) return phone;
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
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

function showToast(msg) {
  toastMessage.value = msg;
  setTimeout(() => {
    toastMessage.value = '';
  }, 2500);
}

// 刷新数据
function refreshAll() {
  localDb.init();
  membersList.value = localDb.getMembers(searchQuery.value);
  dashboard.value = localDb.getDashboard();
  refreshLedgers();
}

function refreshLedgers() {
  ledgersList.value = localDb.getLedgers({ type: ledgerFilterType.value });
}

function handleSearch() {
  membersList.value = localDb.getMembers(searchQuery.value);
}

function clearSearch() {
  searchQuery.value = '';
  refreshAll();
}

// 当前选中的会员流水
const currentMemberLedgers = computed(() => {
  if (!selectedMember.value) return [];
  return localDb.getLedgers({ memberId: selectedMember.value.id });
});

function selectMember(m) {
  const latest = localDb.getMemberById(m.id);
  selectedMember.value = latest || m;
}

// 打开充值
function openRechargeModal(m) {
  rechargingMember.value = m;
  rechargeForm.value = {
    actualPay: 300,
    giftAmount: 40,
    payMethod: '微信支付',
    remark: ''
  };
}

function applyRechargePlan(plan) {
  rechargeForm.value.actualPay = plan.pay;
  rechargeForm.value.giftAmount = plan.gift;
}

// 提交充值
function submitRecharge() {
  try {
    const res = localDb.recharge({
      memberId: rechargingMember.value.id,
      actualPay: rechargeForm.value.actualPay,
      giftAmount: rechargeForm.value.giftAmount,
      payMethod: rechargeForm.value.payMethod,
      remark: rechargeForm.value.remark
    });

    const memberName = rechargingMember.value.name;
    const totalCredit = res.totalCredit / 100;
    const balanceAfter = (res.balanceAfter / 100).toFixed(2);

    rechargingMember.value = null;
    showToast('充值成功！');

    // 微信通知文案
    receiptModal.value = {
      name: memberName,
      messageText: `【理发店会员充值通知】\n尊敬的 ${memberName}，您好！\n本次充值已成功入账：¥${totalCredit.toFixed(2)} 元\n当前卡内剩余额度为：¥${balanceAfter} 元。\n感谢您的支持与惠顾，祝您生活愉快！`
    };

    refreshAll();
    if (selectedMember.value) {
      selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    }
  } catch (err) {
    showToast(err.message);
  }
}

// 打开消费扣款
function openConsumeModal(m) {
  consumingMember.value = m;
  consumeAmountStr.value = '';
  consumeSummary.value = '精致洗剪吹';
}

function setConsumePreset(item) {
  consumeAmountStr.value = item.price.toString();
  consumeSummary.value = item.name;
}

const isConsumeOverBalance = computed(() => {
  if (!consumingMember.value || !consumeAmountStr.value) return false;
  const cent = Math.round(parseFloat(consumeAmountStr.value) * 100);
  return cent > consumingMember.value.balance;
});

// 提交扣款
function submitConsume() {
  const amountNum = parseFloat(consumeAmountStr.value);
  if (!amountNum || amountNum <= 0) {
    showToast('请输入有效的扣款金额');
    return;
  }

  try {
    localDb.consume({
      memberId: consumingMember.value.id,
      amount: amountNum,
      itemsSummary: consumeSummary.value
    });

    consumingMember.value = null;
    showToast(`扣费成功，已扣减 ¥${amountNum.toFixed(2)}`);

    refreshAll();
    if (selectedMember.value) {
      selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    }
  } catch (err) {
    showToast(err.message);
  }
}

// 新增会员
function openNewMemberModal() {
  newMemberForm.value = {
    name: '',
    phone: '',
    initialBalance: 0,
    notes: ''
  };
  showNewMemberModal.value = true;
}

function submitCreateMember() {
  try {
    const created = localDb.createMember(newMemberForm.value);
    showNewMemberModal.value = false;
    showToast(`会员 ${created.name} 建档成功！`);
    refreshAll();
    selectMember(created);
  } catch (err) {
    showToast(err.message);
  }
}

// 复制通知
function copyReceiptText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
    showToast('已复制，可长按粘贴发送给微信顾客');
  } else {
    showToast('请直接长按选中文本复制');
  }
}

// 一键导出备份 (支持 Web Share API 或自动下载)
async function handleExportBackup() {
  try {
    const content = localDb.exportBackupData();
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `理发店会员账本备份_${dateStr}.json`;
    const blob = new Blob([content], { type: 'application/json' });
    const file = new File([blob], fileName, { type: 'application/json' });

    // 手机端如果支持系统分享直接唤起微信分享
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: '理发店会员账本备份',
        text: `备份时间: ${new Date().toLocaleString()}`,
        files: [file]
      });
      showToast('分享成功！');
    } else {
      // 否则触发本地文件下载保存
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      showToast('备份文件已下载到手机，可发送给微信文件传输助手');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('导出异常: ' + err.message);
    }
  }
}

// 导出 CSV
function handleExportCSV() {
  try {
    const csv = localDb.exportCSV();
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `理发店对账明细_${dateStr}.csv`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Excel报表已下载');
  } catch (err) {
    showToast('导出异常: ' + err.message);
  }
}

// 从文件恢复备份
function handleImportBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const res = localDb.importBackupData(event.target.result);
      showToast(`成功恢复 ${res.count} 位会员数据！`);
      refreshAll();
    } catch (err) {
      showToast(err.message);
    }
  };
  reader.readAsText(file);
}

onMounted(() => {
  refreshAll();
});
</script>
