from pathlib import Path

path = Path('src/App.vue')
source = path.read_text(encoding='utf-8')
start = source.index('      <!-- ==================== TAB 1:')
end = source.index('      <!-- ==================== TAB 3:', start)
source = source[:start] + '''      <!-- 统一客户入口：快速扣款与客户档案共享一份列表。 -->
      <Customers v-if="activeTab === 'customers' && !cloudLocked"
        v-model:filter="customerFilter" :members="membersList" :ledgers="customerLedgers"
        :query="searchQuery" :summary="dashboard"
        :can-consume="!storageError && canCloudWrite('consume')"
        :can-create="!storageError && canCloudWrite('createMember')"
        @select="selectMember" @consume="openConsumeModal" @create="openNewMemberModal" />

''' + source[end:]
start = source.index('    <!-- 底部固定导航栏')
end = source.index('    <!-- ==================== 弹窗与抽屉层', start)
source = source[:start] + '''    <!-- 三个主入口，统一客户列表与收银操作。 -->
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

''' + source[end:]
source = source.replace("import CloudSettings from './components/CloudSettings.vue';", "import CloudSettings from './components/CloudSettings.vue';\nimport Customers from './components/Customers.vue';\nimport { UsersRound, ReceiptText, Settings } from 'lucide-vue-next';")
source = source.replace("// 页面标签：'home' | 'members' | 'ledgers' | 'settings'", "// 页面标签：'customers' | 'ledgers' | 'settings'")
source = source.replace("'home'", "'customers'")
source = source.replace("const membersList = ref([]);", "const membersList = ref([]);\nconst customerLedgers = ref([]);\nconst customerFilter = ref('recent');")
source = source.replace("const consumeConfirmation = ref(null);", "const consumeConfirmation = ref(null);\nconst debtAcknowledged = ref(false);")
source = source.replace("    membersList.value = nextMembers;", "    membersList.value = nextMembers;\n    customerLedgers.value = localDb.getLedgers();")
source = source.replace("    membersList.value = [];", "    membersList.value = [];\n    customerLedgers.value = [];")
source = source.replace("'输入会员姓名或手机号码查找…'", "'姓名 / 手机号 / 手机尾号'")
path.write_text(source, encoding='utf-8', newline='\n')
