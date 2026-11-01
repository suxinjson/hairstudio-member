<template>
  <div class="flex flex-col min-h-screen bg-slate-100 text-slate-900 select-none pb-24">
    
    <!-- 顶部导航栏 (专门预留水滴屏/挖孔屏物理安全区，防止遮挡文字) -->
    <header class="bg-slate-950 text-white pt-status-safe sticky top-0 z-30 shadow-lg">
      <div class="px-4 pt-3 pb-3">
        <!-- 标题行与新建按钮 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2.5">
            <span class="text-2xl">✂️</span>
            <div>
              <h1 class="text-xl font-extrabold tracking-tight text-white flex items-center space-x-2">
                <span>理发店会员管家</span>
              </h1>
              <div class="text-xs text-slate-400 font-medium mt-0.5">
                {{ currentDateText }} · 单机离线版
              </div>
            </div>
          </div>

          <button 
            @click="openNewMemberModal"
            class="bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white text-sm px-4 py-2.5 rounded-xl font-bold shadow-md transition btn-press flex items-center space-x-1"
          >
            <span>+ 登记新会员</span>
          </button>
        </div>

        <!-- 醒目大搜索框 (报4位手机尾号或姓名秒查) -->
        <div class="mt-3 relative">
          <input 
            v-model="searchQuery" 
            @input="handleSearch"
            type="text" 
            placeholder="报手机尾号 (如8888) 或输入姓名查找..." 
            class="w-full bg-slate-800/95 border border-slate-700 text-white text-base rounded-2xl pl-11 pr-10 py-3 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition shadow-inner font-medium"
          />
          <span class="absolute left-3.5 top-3.5 text-lg text-slate-400">🔍</span>
          <button 
            v-if="searchQuery" 
            @click="clearSearch"
            class="absolute right-3.5 top-3 text-slate-400 hover:text-white text-base w-7 h-7 flex items-center justify-center rounded-full bg-slate-700 active:bg-slate-600"
          >
            ✕
          </button>
        </div>
      </div>
    </header>

    <!-- 主视口内容 -->
    <main class="flex-1 p-3.5 space-y-3.5">
      
      <!-- ==================== TAB 1: 收银台 / 首页 ==================== -->
      <div v-if="activeTab === 'home'" class="space-y-3.5">
        
        <!-- 今日营业收支卡片 (高对比、大字号、干净清爽) -->
        <div class="bg-white rounded-2xl p-4 shadow-sm border border-slate-200/90">
          <div class="flex items-center justify-between pb-2.5 border-b border-slate-100">
            <span class="text-sm font-bold text-slate-700 flex items-center space-x-1.5">
              <span>📊</span>
              <span>今日小店收银简报</span>
            </span>
            <span class="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full font-bold">
              ✓ 数据已安全落盘
            </span>
          </div>

          <div class="grid grid-cols-2 gap-3 mt-3">
            <div class="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
              <div class="text-xs text-slate-500 font-bold">今日储值实收</div>
              <div class="text-2xl font-black text-emerald-600 tabular-nums mt-1">
                ¥ {{ formatCent(dashboard.today?.rechargeCreditTotal || 0) }}
              </div>
              <div class="text-xs text-slate-500 mt-1">
                入账 {{ dashboard.today?.rechargeCount || 0 }} 笔
              </div>
            </div>

            <div class="bg-slate-50 p-3.5 rounded-xl border border-slate-200">
              <div class="text-xs text-slate-500 font-bold">今日剪发扣额</div>
              <div class="text-2xl font-black text-rose-600 tabular-nums mt-1">
                ¥ {{ formatCent(dashboard.today?.consumeAmount || 0) }}
              </div>
              <div class="text-xs text-slate-500 mt-1">
                到店服务 {{ dashboard.today?.consumeCount || 0 }} 人次
              </div>
            </div>
          </div>

          <div class="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500 font-medium">
            <div>
              全店会员沉淀：<strong class="text-slate-800 text-sm font-bold tabular-nums">¥ {{ formatCent(dashboard.totalBalance || 0) }}</strong>
            </div>
            <div>
              总客户数：<strong class="text-slate-800 text-sm font-bold">{{ dashboard.memberCount || 0 }}</strong> 人
            </div>
          </div>
        </div>

        <!-- 列表标题 -->
        <div class="flex items-center justify-between px-1 pt-1">
          <h2 class="text-sm font-bold text-slate-600">
            {{ searchQuery ? `搜索匹配客户 (${membersList.length})` : '最近来店客户' }}
          </h2>
          <span class="text-xs text-slate-400">点击按钮直接记账</span>
        </div>

        <!-- 空状态提示 -->
        <div v-if="membersList.length === 0" class="bg-white rounded-2xl p-8 text-center border border-slate-200 space-y-2">
          <div class="text-5xl">🔍</div>
          <p class="text-base font-bold text-slate-700">未找到相关会员</p>
          <p class="text-sm text-slate-500">可以直接给新顾客建卡登记</p>
          <div class="pt-2">
            <button 
              @click="openNewMemberModal" 
              class="bg-indigo-600 text-white text-sm px-5 py-2.5 rounded-xl font-bold shadow-md btn-press"
            >
              + 立即建档录入
            </button>
          </div>
        </div>

        <!-- 会员卡片列表 (极速收银：卡片自带扣款与充值，大字清晰) -->
        <div v-else class="space-y-3">
          <div 
            v-for="m in membersList" 
            :key="m.id"
            class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm transition"
          >
            <!-- 顶部：姓名、电话、余额 -->
            <div class="flex items-start justify-between cursor-pointer" @click="selectMember(m)">
              <div class="flex items-start space-x-3">
                <div class="w-12 h-12 rounded-xl bg-slate-900 text-white flex items-center justify-center font-black text-xl shadow-sm flex-shrink-0 mt-0.5">
                  {{ m.name.charAt(0) }}
                </div>
                <div>
                  <div class="flex items-center space-x-2">
                    <span class="font-black text-slate-900 text-lg">{{ m.name }}</span>
                  </div>
                  <div class="text-base text-slate-600 font-bold tracking-wider font-mono mt-0.5">
                    {{ formatPhoneSpaced(m.phone) }}
                  </div>
                  <!-- 发型偏好说明便签 -->
                  <div v-if="m.notes" class="mt-1 text-xs text-amber-900 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-lg inline-block font-medium">
                    💇 {{ m.notes }}
                  </div>
                </div>
              </div>

              <!-- 余额 -->
              <div class="text-right flex-shrink-0">
                <div class="text-xs text-slate-400 font-medium">卡内可用额度</div>
                <div class="text-2xl font-black text-indigo-600 tabular-nums mt-0.5">
                  ¥ {{ formatCent(m.balance) }}
                </div>
              </div>
            </div>

            <!-- 底部两项核心操作按钮 (大按键、单手直达) -->
            <div class="mt-3.5 pt-3 border-t border-slate-100 grid grid-cols-2 gap-2.5">
              <button 
                @click.stop="openConsumeModal(m)"
                class="bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white py-3 rounded-xl font-bold text-base shadow-sm flex items-center justify-center space-x-1 btn-press"
              >
                <span>✂️ 剪发扣款</span>
              </button>

              <button 
                @click.stop="openRechargeModal(m)"
                class="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white py-3 rounded-xl font-bold text-base shadow-sm flex items-center justify-center space-x-1 btn-press"
              >
                <span>💳 会员充值</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== TAB 2: 会员名册 ==================== -->
      <div v-if="activeTab === 'members'" class="space-y-3">
        <div class="flex items-center justify-between px-1">
          <span class="text-sm text-slate-600 font-bold">全店名册 (共 {{ membersList.length }} 人)</span>
          <span class="text-xs text-slate-400">点击查看或编辑档案</span>
        </div>

        <div class="space-y-2.5">
          <div 
            v-for="m in membersList" 
            :key="m.id"
            @click="selectMember(m)"
            class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between active:bg-slate-50 cursor-pointer"
          >
            <div class="flex items-center space-x-3.5">
              <div class="w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-700 to-slate-900 text-white flex items-center justify-center font-bold text-lg shadow-sm">
                {{ m.name.charAt(0) }}
              </div>
              <div>
                <div class="font-extrabold text-slate-900 text-base">{{ m.name }}</div>
                <div class="text-sm text-slate-600 font-semibold font-mono">{{ formatPhoneSpaced(m.phone) }}</div>
                <div v-if="m.notes" class="text-xs text-slate-500 truncate max-w-[160px] mt-0.5">
                  {{ m.notes }}
                </div>
              </div>
            </div>

            <div class="text-right">
              <div class="text-xl font-black text-slate-900 tabular-nums">¥ {{ formatCent(m.balance) }}</div>
              <div class="text-xs text-slate-400 font-medium">累计消费 ¥{{ formatCent(m.total_consume) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== TAB 3: 流水明细与撤销冲正 ==================== -->
      <div v-if="activeTab === 'ledgers'" class="space-y-3">
        <!-- 筛选标签 -->
        <div class="flex space-x-1.5 bg-slate-200/90 p-1.5 rounded-2xl text-sm font-bold">
          <button 
            v-for="type in [{ key: '', label: '全部流水' }, { key: 'CONSUME', label: '剪发扣费' }, { key: 'RECHARGE', label: '储值入账' }, { key: 'REFUND', label: '撤销记录' }]"
            :key="type.key"
            @click="ledgerFilterType = type.key; refreshLedgers()"
            class="flex-1 py-2 rounded-xl transition text-center"
            :class="ledgerFilterType === type.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'"
          >
            {{ type.label }}
          </button>
        </div>

        <div v-if="ledgersList.length === 0" class="bg-white rounded-2xl p-8 text-center border border-slate-200 text-slate-400 text-base">
          暂无相关账目流水
        </div>
        <div v-else class="space-y-2.5">
          <div 
            v-for="item in ledgersList" 
            :key="item.id"
            class="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm text-sm"
          >
            <div class="flex items-center justify-between">
              <div class="flex items-center space-x-2">
                <span 
                  class="px-2.5 py-1 rounded-lg font-bold text-xs"
                  :class="getBadgeClass(item.type)"
                >
                  {{ getTypeText(item.type) }}
                </span>
                <span class="font-extrabold text-slate-900 text-base">{{ item.memberName }}</span>
                <span class="text-slate-500 font-mono font-medium">{{ formatPhoneSpaced(item.memberPhone) }}</span>
              </div>
              <div 
                class="text-base font-black tabular-nums"
                :class="item.changeAmount > 0 ? 'text-emerald-600' : 'text-slate-900'"
              >
                {{ item.changeAmount > 0 ? '+' : '' }}{{ (item.changeAmount / 100).toFixed(2) }} 元
              </div>
            </div>

            <div class="mt-2.5 flex items-center justify-between text-slate-600 pt-2 border-t border-slate-100 text-xs font-medium">
              <div class="truncate max-w-[220px]">
                {{ item.remark || '无项目说明' }}
              </div>
              <div>
                变动后余额: <strong class="text-slate-900 font-bold">¥{{ (item.balanceAfter / 100).toFixed(2) }}</strong>
              </div>
            </div>

            <!-- 时间与撤单操作 -->
            <div class="flex items-center justify-between text-slate-400 text-xs mt-2 pt-1 border-t border-dashed border-slate-100">
              <span>{{ formatTime(item.created_at) }}</span>
              
              <button 
                v-if="item.type !== 'REFUND' && !item.isRefunded"
                @click.stop="confirmRefundLedger(item)"
                class="text-rose-600 hover:text-rose-700 bg-rose-50 px-3 py-1 rounded-lg font-bold active:bg-rose-100 text-xs"
              >
                撤销此单
              </button>
              <span v-else-if="item.isRefunded" class="text-slate-400 bg-slate-100 px-2 py-0.5 rounded font-medium">
                已撤销冲正
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== TAB 4: 服务定价与备份安全 ==================== -->
      <div v-if="activeTab === 'settings'" class="space-y-3.5">
        
        <!-- 理发项目与定价管理 -->
        <div class="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
          <div class="flex items-center justify-between pb-3 border-b border-slate-100">
            <div>
              <h2 class="font-extrabold text-slate-900 text-base">💈 服务项目与定价设置</h2>
              <p class="text-xs text-slate-400 mt-0.5">收银扣款时可一键带入常用项目</p>
            </div>
            <button 
              @click="openAddServiceModal"
              class="bg-indigo-600 text-white text-xs px-3.5 py-2 rounded-xl font-bold shadow btn-press"
            >
              + 新增项目
            </button>
          </div>

          <div class="divide-y divide-slate-100 mt-1">
            <div 
              v-for="s in hairServices" 
              :key="s.id"
              class="py-3 flex items-center justify-between text-sm"
            >
              <div>
                <span class="font-bold text-slate-900 text-base">{{ s.name }}</span>
                <span class="text-indigo-600 font-extrabold ml-2 text-base">¥ {{ s.price }}</span>
              </div>
              <div class="flex space-x-2">
                <button 
                  @click="openEditServiceModal(s)"
                  class="text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-lg font-bold text-xs active:bg-indigo-100"
                >
                  修改
                </button>
                <button 
                  @click="deleteServiceItem(s.id)"
                  class="text-rose-600 bg-rose-50 px-3 py-1.5 rounded-lg font-bold text-xs active:bg-rose-100"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 微信安全备份中心 -->
        <div class="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
          <div class="flex items-center space-x-2.5 mb-2">
            <span class="text-2xl">🛡️</span>
            <div>
              <h2 class="font-extrabold text-slate-900 text-base">单机账本安全与微信备份</h2>
              <p class="text-xs text-slate-400">数据存放在手机安全沙盒，微信备份双重保险</p>
            </div>
          </div>

          <div class="space-y-2.5 mt-3.5">
            <!-- 导出备份发到微信 -->
            <button 
              @click="handleExportBackup"
              class="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white p-4 rounded-xl font-bold text-sm flex items-center justify-between shadow btn-press"
            >
              <div class="flex items-center space-x-2.5">
                <span class="text-xl">📤</span>
                <div class="text-left">
                  <div class="text-base">一键备份所有账本 (发送至微信)</div>
                  <div class="text-xs text-emerald-100 font-normal">生成全店加密备份文件，发给微信文件传输助手保存</div>
                </div>
              </div>
              <span class="text-lg">›</span>
            </button>

            <!-- 导出 Excel 表格 -->
            <button 
              @click="handleExportCSV"
              class="w-full bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white p-4 rounded-xl font-bold text-sm flex items-center justify-between shadow btn-press"
            >
              <div class="flex items-center space-x-2.5">
                <span class="text-xl">📊</span>
                <div class="text-left">
                  <div class="text-base">导出 Excel 对账明细表 (.csv)</div>
                  <div class="text-xs text-blue-100 font-normal">手机 WPS 或电脑直接打开核算对账</div>
                </div>
              </div>
              <span class="text-lg">›</span>
            </button>

            <!-- 恢复备份 -->
            <div class="pt-2">
              <label class="w-full bg-slate-100 hover:bg-slate-200 active:bg-slate-300 text-slate-700 p-4 rounded-xl font-bold text-sm flex items-center justify-between border border-slate-200 cursor-pointer">
                <div class="flex items-center space-x-2.5">
                  <span class="text-xl">📥</span>
                  <div class="text-left">
                    <div class="text-base text-slate-900">从微信备份文件恢复数据</div>
                    <div class="text-xs text-slate-500 font-normal">换新手机或误删时，选中文件 1 秒瞬间还原</div>
                  </div>
                </div>
                <span class="text-indigo-600 font-bold text-xs bg-indigo-50 px-2.5 py-1 rounded-lg">选择文件</span>
                <input type="file" accept=".json" @change="handleImportBackup" class="hidden" />
              </label>
            </div>
          </div>
        </div>

        <!-- 理发店省心锦囊 -->
        <div class="bg-indigo-50 border border-indigo-100 p-4 rounded-2xl text-xs text-indigo-950 space-y-1.5 leading-relaxed">
          <div class="font-extrabold text-sm flex items-center space-x-1">
            <span>💡</span>
            <span>理发店安心记账小贴士：</span>
          </div>
          <p>1. 本 App 是<strong>纯安卓独立原生应用</strong>，运行在手机专属私有沙盒内，手机管家清理“垃圾缓存”不会误删账本。</p>
          <p>2. 建议<strong>每周日打烊时</strong>顺手点击「一键备份所有账本」，发一份给微信“文件传输助手”，双保险万无一失！</p>
        </div>
      </div>

    </main>

    <!-- 底部固定导航栏 (适配全面屏手势条，大触控热区) -->
    <nav class="fixed bottom-0 left-0 right-0 max-w-[500px] mx-auto bg-white/95 backdrop-blur-md border-t border-slate-200 z-30 pb-gesture-safe shadow-lg">
      <div class="grid grid-cols-4 h-16">
        <button 
          @click="activeTab = 'home'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'home' ? 'text-indigo-600 font-extrabold' : 'text-slate-400 font-medium'"
        >
          <span class="text-2xl">🏪</span>
          <span class="text-xs mt-1">收银台</span>
        </button>

        <button 
          @click="activeTab = 'members'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'members' ? 'text-indigo-600 font-extrabold' : 'text-slate-400 font-medium'"
        >
          <span class="text-2xl">👥</span>
          <span class="text-xs mt-1">会员库</span>
        </button>

        <button 
          @click="activeTab = 'ledgers'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'ledgers' ? 'text-indigo-600 font-extrabold' : 'text-slate-400 font-medium'"
        >
          <span class="text-2xl">📋</span>
          <span class="text-xs mt-1">账单流水</span>
        </button>

        <button 
          @click="activeTab = 'settings'"
          class="flex flex-col items-center justify-center transition"
          :class="activeTab === 'settings' ? 'text-indigo-600 font-extrabold' : 'text-slate-400 font-medium'"
        >
          <span class="text-2xl">⚙️</span>
          <span class="text-xs mt-1">设置备份</span>
        </button>
      </div>
    </nav>

    <!-- ==================== 弹窗与抽屉层 ==================== -->

    <!-- 1. 剪发消费扣款抽屉 (核心大按键收银台) -->
    <div 
      v-if="consumingMember" 
      class="fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in"
      @click.self="consumingMember = null"
    >
      <div class="bg-white rounded-t-3xl flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full">
        <!-- 弹窗顶栏 -->
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div class="font-black text-lg text-slate-900 flex items-center space-x-2">
              <span>✂️ 剪发扣款</span>
              <span class="text-indigo-600">— {{ consumingMember.name }}</span>
            </div>
            <div class="text-sm text-slate-500 font-medium mt-0.5">
              卡内可用余额：<strong class="text-indigo-600 text-base font-extrabold tabular-nums">¥ {{ formatCent(consumingMember.balance) }}</strong>
            </div>
          </div>
          <button 
            @click="consumingMember = null" 
            class="w-9 h-9 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-lg font-bold active:bg-slate-200"
          >
            ✕
          </button>
        </div>

        <!-- 顾客发型习惯便签 -->
        <div v-if="consumingMember.notes" class="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-900 font-bold flex items-center space-x-1">
          <span>💇 发型偏好：</span>
          <span>{{ consumingMember.notes }}</span>
        </div>

        <!-- 金额展示区 (超大数字) -->
        <div class="p-4 bg-slate-50 text-center border-b border-slate-200">
          <div class="text-xs font-bold text-slate-500 uppercase tracking-wider">本次扣款金额 (元)</div>
          <div class="text-4xl font-black text-slate-900 tracking-tight tabular-nums mt-1 flex items-center justify-center">
            <span class="text-2xl mr-1.5 text-slate-400">¥</span>
            <span>{{ consumeAmountStr || '0.00' }}</span>
          </div>

          <!-- 余额不足红字警示 -->
          <div v-if="isConsumeOverBalance" class="text-xs text-rose-600 font-bold mt-1.5 bg-rose-50 border border-rose-200 py-1.5 px-3 rounded-lg inline-block">
            ⚠️ 扣款金额超过当前卡内余额，无法扣费！
          </div>
        </div>

        <!-- 常用理发服务一键快捷带入 -->
        <div class="p-3.5 bg-white border-b border-slate-100">
          <div class="text-xs font-bold text-slate-500 mb-2">点击一键带入常用项目与金额：</div>
          <div class="flex flex-wrap gap-2">
            <button 
              v-for="item in hairServices" 
              :key="item.id"
              @click="setConsumePreset(item)"
              class="text-sm px-3.5 py-2 rounded-xl border border-slate-200 bg-slate-50 active:bg-indigo-50 active:border-indigo-400 text-slate-800 font-bold btn-press"
            >
              {{ item.name }} (¥{{ item.price }})
            </button>
          </div>

          <div class="mt-2.5">
            <input 
              v-model="consumeSummary" 
              type="text" 
              placeholder="项目明细备注 (如：精致洗剪吹 + 护发素)..." 
              class="w-full text-sm p-2.5 bg-slate-100 rounded-xl border-0 focus:ring-2 focus:ring-indigo-500 outline-none font-medium"
            />
          </div>
        </div>

        <!-- 手机专属大按键数字软键盘 -->
        <Keypad 
          v-model="consumeAmountStr" 
          confirmText="确认扣除" 
          theme="danger"
          :disabled="isConsumeOverBalance"
          @confirm="submitConsume" 
        />
      </div>
    </div>

    <!-- 2. 会员储值充值抽屉 -->
    <div 
      v-if="rechargingMember" 
      class="fixed inset-0 bg-black/60 z-50 flex flex-col justify-end animate-fade-in"
      @click.self="rechargingMember = null"
    >
      <div class="bg-white rounded-t-3xl max-h-[92vh] flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div class="font-black text-lg text-slate-900">
              💳 会员储值 — {{ rechargingMember.name }}
            </div>
            <div class="text-sm text-slate-500 font-medium mt-0.5">
              当前卡内余额：<strong class="text-indigo-600 font-extrabold">¥ {{ formatCent(rechargingMember.balance) }}</strong>
            </div>
          </div>
          <button @click="rechargingMember = null" class="w-9 h-9 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-lg font-bold">✕</button>
        </div>

        <div class="p-4 overflow-y-auto space-y-4">
          <!-- 快捷充值档位 -->
          <div>
            <div class="text-xs font-bold text-slate-500 mb-2">快捷充值套餐</div>
            <div class="grid grid-cols-3 gap-2.5">
              <button 
                v-for="plan in rechargePlans" 
                :key="plan.pay"
                @click="applyRechargePlan(plan)"
                class="p-3 rounded-2xl border text-center transition btn-press"
                :class="rechargeForm.actualPay == plan.pay && rechargeForm.giftAmount == plan.gift ? 'border-emerald-600 bg-emerald-50 text-emerald-900 font-black' : 'border-slate-200 bg-slate-50 text-slate-700 font-bold'"
              >
                <div class="text-base font-extrabold">充¥{{ plan.pay }}</div>
                <div class="text-xs text-emerald-600 font-bold mt-0.5">
                  {{ plan.gift > 0 ? `送¥${plan.gift}` : '到账¥' + plan.pay }}
                </div>
              </button>
            </div>
          </div>

          <!-- 自定义实付与赠送 -->
          <div class="space-y-3 bg-slate-50 p-4 rounded-2xl border border-slate-200">
            <div>
              <label class="text-xs font-bold text-slate-600 block mb-1">实收充值金额 (元)</label>
              <input 
                v-model.number="rechargeForm.actualPay" 
                type="number" 
                step="0.01" 
                placeholder="0.00"
                class="w-full bg-white p-3 text-lg font-black text-slate-900 rounded-xl border border-slate-300 outline-none focus:border-emerald-500"
              />
            </div>

            <div>
              <label class="text-xs font-bold text-slate-600 block mb-1">额外赠送额度 (元，可填0)</label>
              <input 
                v-model.number="rechargeForm.giftAmount" 
                type="number" 
                step="0.01" 
                placeholder="0.00"
                class="w-full bg-white p-3 text-lg font-black text-emerald-600 rounded-xl border border-slate-300 outline-none focus:border-emerald-500"
              />
            </div>

            <div class="pt-2.5 border-t border-slate-200 flex justify-between items-center text-sm">
              <span class="text-slate-600 font-bold">实际到账总额度：</span>
              <span class="font-black text-emerald-600 text-xl tabular-nums">
                ¥ {{ ((Number(rechargeForm.actualPay || 0) + Number(rechargeForm.giftAmount || 0))).toFixed(2) }}
              </span>
            </div>
          </div>

          <!-- 收款渠道 -->
          <div>
            <div class="text-xs font-bold text-slate-500 mb-2">收款渠道</div>
            <div class="grid grid-cols-4 gap-2 text-sm font-bold">
              <button 
                v-for="m in ['微信支付', '支付宝', '现金收款', '其他方式']"
                :key="m"
                @click="rechargeForm.payMethod = m"
                class="py-2.5 rounded-xl border text-center transition"
                :class="rechargeForm.payMethod === m ? 'border-emerald-600 bg-emerald-50 text-emerald-900 font-black' : 'border-slate-200 text-slate-600'"
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
              placeholder="例：周年店庆活动储值" 
              class="w-full text-sm p-3 bg-slate-50 rounded-xl border border-slate-200 outline-none font-medium"
            />
          </div>
        </div>

        <div class="p-4 border-t border-slate-100 bg-white pb-gesture-safe">
          <button 
            @click="submitRecharge"
            :disabled="!(rechargeForm.actualPay > 0 || rechargeForm.giftAmount > 0)"
            class="w-full bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 disabled:bg-slate-300 text-white py-3.5 rounded-xl font-extrabold text-base shadow-md btn-press"
          >
            确认完成充值
          </button>
        </div>
      </div>
    </div>

    <!-- 3. 会员详情卡片抽屉 (点击会员查看全貌) -->
    <div 
      v-if="selectedMember" 
      class="fixed inset-0 bg-black/60 z-40 flex flex-col justify-end animate-fade-in"
      @click.self="selectedMember = null"
    >
      <div class="bg-white rounded-t-3xl max-h-[90vh] flex flex-col animate-slide-up shadow-2xl max-w-[500px] mx-auto w-full">
        <div class="p-4 border-b border-slate-100 flex items-center justify-between">
          <div class="flex items-center space-x-3">
            <div class="w-12 h-12 rounded-xl bg-slate-900 text-white flex items-center justify-center font-bold text-xl">
              {{ selectedMember.name.charAt(0) }}
            </div>
            <div>
              <div class="flex items-center space-x-2">
                <h3 class="font-extrabold text-lg text-slate-900">{{ selectedMember.name }}</h3>
                <span class="text-xs bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded-full font-bold">储值会员</span>
              </div>
              <div class="text-sm text-slate-500 font-mono font-semibold">{{ formatPhoneSpaced(selectedMember.phone) }}</div>
            </div>
          </div>
          <div class="flex items-center space-x-2">
            <button 
              @click="openEditMemberModal(selectedMember)"
              class="text-xs text-indigo-600 bg-indigo-50 px-3 py-1.5 rounded-xl font-bold active:bg-indigo-100"
            >
              修改档案
            </button>
            <button 
              @click="selectedMember = null" 
              class="w-9 h-9 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-lg font-bold"
            >
              ✕
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto p-4 space-y-4">
          <!-- 醒目大额度渐变卡片 -->
          <div class="bg-gradient-to-br from-slate-900 to-indigo-950 rounded-2xl p-5 text-white shadow-md relative">
            <div class="text-xs text-indigo-200 font-bold uppercase tracking-wider">卡内当前可用额度</div>
            <div class="text-4xl font-black tracking-tight mt-1 tabular-nums">
              ¥ {{ formatCent(selectedMember.balance) }}
            </div>

            <div class="grid grid-cols-2 gap-2 mt-4 pt-3.5 border-t border-slate-800 text-xs">
              <div>
                <span class="text-slate-400">历史累计储值：</span>
                <span class="font-bold tabular-nums">¥{{ formatCent(selectedMember.total_recharge) }}</span>
              </div>
              <div>
                <span class="text-slate-400">历史累计消费：</span>
                <span class="font-bold tabular-nums">¥{{ formatCent(selectedMember.total_consume) }}</span>
              </div>
            </div>
          </div>

          <!-- 发型偏好说明 -->
          <div v-if="selectedMember.notes" class="bg-amber-50 p-3.5 rounded-xl border border-amber-200 text-sm text-amber-900">
            <strong>💇 发型习惯偏好：</strong> {{ selectedMember.notes }}
          </div>

          <!-- 近期交易明细 -->
          <div>
            <div class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
              近期消费与充值记录 ({{ currentMemberLedgers.length }})
            </div>

            <div v-if="currentMemberLedgers.length === 0" class="text-sm text-slate-400 py-4 text-center">
              暂无历史记录
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
                      class="px-2 py-0.5 rounded text-[11px] font-bold"
                      :class="getBadgeClass(l.type)"
                    >
                      {{ getTypeText(l.type) }}
                    </span>
                    <span class="font-bold text-slate-800 text-sm">{{ l.remark || '无' }}</span>
                  </div>
                  <div class="text-slate-400 mt-1">
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
                  <div class="text-slate-400">
                    余额: ¥{{ (l.balanceAfter / 100).toFixed(2) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 删除会员 (仅当余额为0时) -->
          <div v-if="selectedMember.balance === 0" class="pt-2 text-center">
            <button 
              @click="handleDeleteMember(selectedMember)"
              class="text-xs text-rose-500 underline font-medium"
            >
              删除注销此会员档案 (仅限余额为0)
            </button>
          </div>
        </div>

        <!-- 底部快捷充值与扣款 -->
        <div class="p-4 border-t border-slate-200 bg-white grid grid-cols-2 gap-3 pb-gesture-safe">
          <button 
            @click="openRechargeModal(selectedMember)"
            class="bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white py-3.5 rounded-xl font-bold text-base shadow-md flex items-center justify-center space-x-1 btn-press"
          >
            <span>💳 额度充值</span>
          </button>

          <button 
            @click="openConsumeModal(selectedMember)"
            class="bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white py-3.5 rounded-xl font-bold text-base shadow-md flex items-center justify-center space-x-1 btn-press"
          >
            <span>✂️ 剪发扣款</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 4. 新增/编辑会员档案弹窗 -->
    <div 
      v-if="showMemberModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
      @click.self="showMemberModal = false"
    >
      <div class="bg-white rounded-3xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
        <div class="flex items-center justify-between border-b pb-2.5">
          <h3 class="font-extrabold text-lg text-slate-900">
            {{ editingMemberId ? '修改会员档案' : '登记新会员档案' }}
          </h3>
          <button @click="showMemberModal = false" class="text-slate-400 text-lg">✕</button>
        </div>

        <div class="space-y-3.5 text-sm">
          <div>
            <label class="font-bold text-slate-700 block mb-1">客户姓名 <span class="text-rose-500">*</span></label>
            <input 
              v-model="memberForm.name" 
              type="text" 
              placeholder="如：张姐 / 8号熟客" 
              class="w-full p-3 border rounded-xl outline-none focus:border-indigo-500 font-bold"
            />
          </div>

          <div>
            <label class="font-bold text-slate-700 block mb-1">手机号码 <span class="text-rose-500">*</span></label>
            <input 
              v-model="memberForm.phone" 
              type="tel" 
              placeholder="报手机尾号查找的唯一依据" 
              class="w-full p-3 border rounded-xl outline-none focus:border-indigo-500 font-mono font-bold"
            />
          </div>

          <div v-if="!editingMemberId">
            <label class="font-bold text-slate-700 block mb-1">开卡初始储值额 (元，可填0)</label>
            <input 
              v-model.number="memberForm.initialBalance" 
              type="number" 
              step="0.01" 
              placeholder="0.00" 
              class="w-full p-3 border rounded-xl outline-none focus:border-indigo-500 font-bold"
            />
          </div>

          <div>
            <label class="font-bold text-slate-700 block mb-1">发型与习惯偏好备注</label>
            <textarea 
              v-model="memberForm.notes" 
              rows="2" 
              placeholder="如：短发圆寸、染发板栗色、不喜欢推子太贴皮等" 
              class="w-full p-2.5 border rounded-xl outline-none focus:border-indigo-500 resize-none font-medium"
            ></textarea>
          </div>
        </div>

        <div class="flex space-x-2.5 pt-2">
          <button 
            @click="showMemberModal = false"
            class="flex-1 py-3 rounded-xl border border-slate-300 text-sm font-bold text-slate-600"
          >
            取消
          </button>
          <button 
            @click="submitMemberForm"
            :disabled="!memberForm.name || !memberForm.phone"
            class="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-300 text-sm font-extrabold text-white shadow"
          >
            保存档案
          </button>
        </div>
      </div>
    </div>

    <!-- 5. 服务定价增改弹窗 -->
    <div 
      v-if="showServiceModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
      @click.self="showServiceModal = false"
    >
      <div class="bg-white rounded-3xl max-w-sm w-full p-5 space-y-4 shadow-2xl">
        <div class="flex items-center justify-between border-b pb-2.5">
          <h3 class="font-extrabold text-lg text-slate-900">
            {{ serviceForm.id ? '修改服务项目' : '新增服务项目' }}
          </h3>
          <button @click="showServiceModal = false" class="text-slate-400 text-lg">✕</button>
        </div>

        <div class="space-y-3.5 text-sm">
          <div>
            <label class="font-bold text-slate-700 block mb-1">服务项目名称 <span class="text-rose-500">*</span></label>
            <input 
              v-model="serviceForm.name" 
              type="text" 
              placeholder="如：洗剪吹 / 精油护理" 
              class="w-full p-3 border rounded-xl outline-none focus:border-indigo-500 font-bold"
            />
          </div>

          <div>
            <label class="font-bold text-slate-700 block mb-1">默认价格 (元) <span class="text-rose-500">*</span></label>
            <input 
              v-model.number="serviceForm.price" 
              type="number" 
              step="0.01" 
              placeholder="0.00" 
              class="w-full p-3 border rounded-xl outline-none focus:border-indigo-500 font-bold"
            />
          </div>
        </div>

        <div class="flex space-x-2.5 pt-2">
          <button 
            @click="showServiceModal = false"
            class="flex-1 py-3 rounded-xl border border-slate-300 text-sm font-bold text-slate-600"
          >
            取消
          </button>
          <button 
            @click="submitServiceForm"
            :disabled="!serviceForm.name || serviceForm.price === ''"
            class="flex-1 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-300 text-sm font-extrabold text-white shadow"
          >
            保存项目
          </button>
        </div>
      </div>
    </div>

    <!-- 6. 充值微信致谢通知卡片 -->
    <div 
      v-if="receiptModal" 
      class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 animate-fade-in"
      @click.self="receiptModal = null"
    >
      <div class="bg-white rounded-3xl max-w-sm w-full p-5 space-y-3.5 shadow-2xl text-center">
        <div class="w-14 h-14 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto text-3xl">
          ✓
        </div>
        <h3 class="font-black text-slate-900 text-xl">充值入账成功</h3>
        <p class="text-sm text-slate-500">已为会员 {{ receiptModal.name }} 存入额度</p>

        <div class="bg-slate-50 p-3.5 rounded-2xl border border-slate-200 text-left text-xs text-slate-700 leading-relaxed font-mono select-all">
          {{ receiptModal.messageText }}
        </div>

        <button 
          @click="copyReceiptText(receiptModal.messageText)"
          class="w-full py-3.5 bg-indigo-600 text-white rounded-xl text-sm font-extrabold shadow-md active:bg-indigo-700 btn-press"
        >
          📋 一键复制致谢文案 (微信发给顾客)
        </button>

        <button 
          @click="receiptModal = null"
          class="w-full py-2 text-slate-400 text-sm font-medium"
        >
          关闭
        </button>
      </div>
    </div>

    <!-- 浮动 Toast 消息通知 -->
    <div 
      v-if="toastMessage" 
      class="fixed top-24 left-1/2 -translate-x-1/2 bg-slate-900/95 backdrop-blur-md text-white text-sm font-bold px-5 py-3 rounded-full shadow-2xl z-50 animate-fade-in flex items-center space-x-2 border border-slate-700"
    >
      <span>ℹ️</span>
      <span>{{ toastMessage }}</span>
    </div>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { localDb } from './storage.js';
import Keypad from './components/Keypad.vue';

// 页面标签：'home' | 'members' | 'ledgers' | 'settings'
const activeTab = ref('home');

// 全局响应式状态
const dashboard = ref({});
const membersList = ref([]);
const ledgersList = ref([]);
const hairServices = ref([]);
const rechargePlans = ref([]);
const searchQuery = ref('');
const toastMessage = ref('');

// 选中的会员卡片
const selectedMember = ref(null);

// 剪发扣款抽屉
const consumingMember = ref(null);
const consumeAmountStr = ref('');
const consumeSummary = ref('精致洗剪吹');

// 储值充值抽屉
const rechargingMember = ref(null);
const rechargeForm = ref({
  actualPay: 300,
  giftAmount: 40,
  payMethod: '微信支付',
  remark: ''
});

// 新建/修改会员
const showMemberModal = ref(false);
const editingMemberId = ref(null);
const memberForm = ref({
  name: '',
  phone: '',
  initialBalance: 0,
  notes: ''
});

// 服务项目增删改
const showServiceModal = ref(false);
const serviceForm = ref({
  id: '',
  name: '',
  price: 38
});

// 微信通知
const receiptModal = ref(null);
const ledgerFilterType = ref('');

// 日期文本展示
const currentDateText = computed(() => {
  const d = new Date();
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
  if (!phone || phone.length < 11) return phone || '';
  return `${phone.slice(0, 3)} ${phone.slice(3, 7)} ${phone.slice(7)}`;
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
  toastMessage.value = msg;
  setTimeout(() => {
    toastMessage.value = '';
  }, 2500);
}

// 刷新全量数据
function refreshAll() {
  localDb.init();
  membersList.value = localDb.getMembers(searchQuery.value);
  dashboard.value = localDb.getDashboard();
  hairServices.value = localDb.getServices();
  rechargePlans.value = [
    { pay: 200, gift: 20 },
    { pay: 300, gift: 40 },
    { pay: 500, gift: 80 },
    { pay: 1000, gift: 200 },
    { pay: 2000, gift: 500 }
  ];
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

// 扣款
function openConsumeModal(m) {
  consumingMember.value = m;
  consumeAmountStr.value = '';
  const first = hairServices.value[0];
  consumeSummary.value = first ? first.name : '精致洗剪吹';
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

// 错单撤回 / 冲正
function confirmRefundLedger(item) {
  const amountYuan = Math.abs(item.changeAmount / 100).toFixed(2);
  const actionText = item.type === 'CONSUME' ? `撤销扣款并退还 ¥${amountYuan}` : `撤销充值并扣回 ¥${amountYuan}`;
  if (!confirm(`确定要${actionText}吗？系统将自动原路冲正恢复会员额度。`)) return;

  try {
    const res = localDb.refundLedger(item.id, '店主撤单冲正');
    showToast(`撤销成功，卡内余额更新为 ¥${(res.newBalance / 100).toFixed(2)}`);
    refreshAll();
    if (selectedMember.value) {
      selectedMember.value = localDb.getMemberById(selectedMember.value.id);
    }
  } catch (err) {
    showToast('撤销失败: ' + err.message);
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
    showToast(err.message);
  }
}

function handleDeleteMember(m) {
  if (!confirm(`确定要彻底删除会员「${m.name}」吗？`)) return;
  try {
    localDb.deleteMember(m.id);
    selectedMember.value = null;
    showToast('会员档案已注销');
    refreshAll();
  } catch (err) {
    showToast(err.message);
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
  try {
    localDb.saveService(serviceForm.value);
    showServiceModal.value = false;
    showToast('服务项目已更新');
    hairServices.value = localDb.getServices();
  } catch (err) {
    showToast(err.message);
  }
}

function deleteServiceItem(id) {
  if (!confirm('确定要删除该服务项目吗？')) return;
  hairServices.value = localDb.deleteService(id);
  showToast('服务项目已删除');
}

function copyReceiptText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板，可粘贴发给顾客微信');
  } else {
    showToast('请长按选中文本复制');
  }
}

// 微信/手机一键备份导出
async function handleExportBackup() {
  try {
    const content = localDb.exportBackupData();
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `理发店会员账本备份_${dateStr}.json`;
    const blob = new Blob([content], { type: 'application/json' });
    const file = new File([blob], fileName, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: '理发店会员账本备份',
        text: `备份时间: ${new Date().toLocaleString()}`,
        files: [file]
      });
      showToast('已唤起分享！');
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      showToast('备份文件已下载保存');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast('导出异常: ' + err.message);
    }
  }
}

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
