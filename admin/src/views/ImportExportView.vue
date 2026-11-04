<template>
  <div class="space-y-6">
    <!-- 顶部安全特性提示条 -->
    <div class="bg-gradient-to-r from-emerald-900 to-teal-950 text-white p-6 rounded-3xl shadow-sm border border-emerald-800/60">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-800/80 text-emerald-200 text-xs font-bold mb-2">
            <span>🛡️</span> 工业级批量数据引擎 · 安全防护加固
          </div>
          <h2 class="text-xl font-black">会员批量导入 & 数据备份导出工作台</h2>
          <p class="text-xs text-emerald-200/90 mt-1 max-w-2xl leading-relaxed">
            支持美团管家、客如云、博卡、唯美等市面系统导出的 Excel / CSV 表格迁移。全流程防公式注入清洗、入库前零损预检、重复冲突自选处理，确保账本资金绝对安全。
          </p>
        </div>
        <button
          @click="downloadTemplate"
          class="h-11 px-4 bg-white hover:bg-emerald-50 text-emerald-950 rounded-2xl text-xs font-black shadow transition btn-press flex items-center gap-2"
        >
          <span>📥</span> 下载标准导入示例模板 (.xlsx)
        </button>
      </div>
    </div>

    <!-- 导入步骤容器 -->
    <div class="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-6 space-y-6">
      <h3 class="font-black text-slate-900 text-base flex items-center gap-2 border-b border-slate-100 pb-3">
        <span>1.</span> 上传会员数据表格 (Excel / CSV)
      </h3>

      <!-- 拖拽上传区域 -->
      <div
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleFileDrop"
        class="border-2 border-dashed rounded-3xl p-8 text-center transition cursor-pointer flex flex-col items-center justify-center gap-3"
        :class="isDragging ? 'border-emerald-600 bg-emerald-50/50' : 'border-slate-300 hover:border-emerald-500 hover:bg-slate-50/60'"
        @click="triggerFileInput"
      >
        <input
          ref="fileInputRef"
          type="file"
          accept=".xlsx,.xls,.csv"
          class="hidden"
          @change="handleFileSelect"
        />

        <div class="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center text-3xl shadow-inner">
          📄
        </div>
        <div>
          <div class="text-sm font-black text-slate-800">
            {{ currentFile ? currentFile.name : '点击或将 Excel / CSV 文件拖拽至此处' }}
          </div>
          <div class="text-xs text-slate-400 mt-1">
            {{ currentFile ? `文件大小：${(currentFile.size / 1024).toFixed(1)} KB` : '支持 .xlsx、.xls、.csv 格式，单次最大支持 10MB（建议 ≤ 10,000 行）' }}
          </div>
        </div>

        <button
          v-if="currentFile"
          type="button"
          @click.stop="resetUpload"
          class="mt-2 text-xs font-bold text-rose-600 hover:underline"
        >
          重新选择文件
        </button>
      </div>

      <!-- 步骤2：识别结果与表头映射配置 -->
      <div v-if="parseResult" class="space-y-4 pt-3 border-t border-slate-100">
        <h3 class="font-black text-slate-900 text-base flex items-center gap-2">
          <span>2.</span> 智能字段映射确认 (已自动识别匹配)
        </h3>

        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div v-for="(field, key) in fieldDefinitions" :key="key" class="p-3 bg-slate-50 rounded-2xl border border-slate-200/80">
            <div class="text-xs font-bold text-slate-700 mb-1 flex items-center justify-between">
              <span>{{ field.label }}</span>
              <span v-if="field.required" class="text-rose-500 font-bold">*必填</span>
            </div>
            <select
              v-model="customMapping[key]"
              class="w-full h-9 px-2 bg-white border border-slate-300 rounded-xl text-xs font-bold focus:outline-none focus:border-emerald-600"
            >
              <option :value="null">-- 未选择 --</option>
              <option
                v-for="(header, idx) in parseResult.headers"
                :key="idx"
                :value="idx"
              >
                第{{ idx + 1 }}列: {{ header || '(空表头)' }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <!-- 步骤3：冲突处理策略与预检校验 -->
      <div v-if="parseResult" class="space-y-4 pt-3 border-t border-slate-100">
        <h3 class="font-black text-slate-900 text-base flex items-center gap-2">
          <span>3.</span> 现有会员重复时的冲突处理策略
        </h3>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label
            class="p-4 rounded-2xl border-2 cursor-pointer transition flex items-start gap-3"
            :class="conflictStrategy === 'skip' ? 'border-emerald-600 bg-emerald-50/40 text-emerald-950' : 'border-slate-200 hover:border-slate-300'"
          >
            <input type="radio" v-model="conflictStrategy" value="skip" class="mt-1 text-emerald-600 focus:ring-emerald-500" />
            <div>
              <div class="text-sm font-black">跳过已有会员（推荐）</div>
              <div class="text-xs text-slate-500 mt-1">若手机号已在系统中存在，保持原会员资料和余额不变，只导入全新会员。</div>
            </div>
          </label>

          <label
            class="p-4 rounded-2xl border-2 cursor-pointer transition flex items-start gap-3"
            :class="conflictStrategy === 'merge_balance' ? 'border-emerald-600 bg-emerald-50/40 text-emerald-950' : 'border-slate-200 hover:border-slate-300'"
          >
            <input type="radio" v-model="conflictStrategy" value="merge_balance" class="mt-1 text-emerald-600 focus:ring-emerald-500" />
            <div>
              <div class="text-sm font-black">累加储值余额（增量合并）</div>
              <div class="text-xs text-slate-500 mt-1">对已有会员，保留原档案，将其表格中的余额作为“期初导入充值”流水叠加累加。</div>
            </div>
          </label>

          <label
            class="p-4 rounded-2xl border-2 cursor-pointer transition flex items-start gap-3"
            :class="conflictStrategy === 'overwrite_profile' ? 'border-emerald-600 bg-emerald-50/40 text-emerald-950' : 'border-slate-200 hover:border-slate-300'"
          >
            <input type="radio" v-model="conflictStrategy" value="overwrite_profile" class="mt-1 text-emerald-600 focus:ring-emerald-500" />
            <div>
              <div class="text-sm font-black">更新资料备注（不改余额）</div>
              <div class="text-xs text-slate-500 mt-1">覆盖更新已有会员的姓名与备注偏好，但绝不更改其已有资金余额，防误覆盖。</div>
            </div>
          </label>
        </div>

        <!-- 触发预检按钮 -->
        <div class="flex items-center gap-3 pt-2">
          <button
            @click="runValidation"
            :disabled="isValidating || customMapping.name === null || customMapping.phone === null"
            class="h-11 px-6 bg-slate-900 hover:bg-slate-800 text-white rounded-2xl text-xs font-black transition btn-press disabled:opacity-40 flex items-center gap-2"
          >
            <span v-if="isValidating" class="animate-spin text-sm">⏳</span>
            <span>{{ isValidating ? '全面深度预检中...' : '开始零损数据预检 (Dry-Run)' }}</span>
          </button>
          <span v-if="customMapping.name === null || customMapping.phone === null" class="text-xs text-rose-500 font-bold">
            * 必须至少指定会员姓名与手机号码对应的列
          </span>
        </div>
      </div>

      <!-- 步骤4：预检报告与预览表格 -->
      <div v-if="validationReport" class="space-y-4 pt-4 border-t border-slate-100">
        <h3 class="font-black text-slate-900 text-base flex items-center justify-between">
          <span>4. 数据预检体检报告</span>
          <button
            v-if="validationReport.invalidCount > 0"
            @click="downloadErrors"
            class="text-xs font-bold text-rose-600 bg-rose-50 border border-rose-200 px-3 py-1.5 rounded-xl hover:bg-rose-100 transition flex items-center gap-1"
          >
            <span>📥</span> 下载 {{ validationReport.invalidCount }} 条失败记录对照表 (.xlsx)
          </button>
        </h3>

        <!-- 体检统计卡片 -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div class="p-4 rounded-2xl bg-slate-50 border border-slate-200">
            <div class="text-xs font-bold text-slate-500">待导入总数据</div>
            <div class="text-xl font-black text-slate-900 mt-1 tabular-nums">{{ validationReport.total }} 条</div>
          </div>
          <div class="p-4 rounded-2xl bg-emerald-50 border border-emerald-200">
            <div class="text-xs font-bold text-emerald-700">全新会员 (合规)</div>
            <div class="text-xl font-black text-emerald-800 mt-1 tabular-nums">{{ validationReport.validCount }} 条</div>
          </div>
          <div class="p-4 rounded-2xl bg-amber-50 border border-amber-200">
            <div class="text-xs font-bold text-amber-700">重复/冲突记录</div>
            <div class="text-xl font-black text-amber-800 mt-1 tabular-nums">{{ validationReport.conflictCount }} 条</div>
          </div>
          <div class="p-4 rounded-2xl bg-rose-50 border border-rose-200">
            <div class="text-xs font-bold text-rose-700">格式异常/不合格</div>
            <div class="text-xl font-black text-rose-800 mt-1 tabular-nums">{{ validationReport.invalidCount }} 条</div>
          </div>
        </div>

        <!-- 详细样本预览列表 (前 15 行) -->
        <div class="rounded-2xl border border-slate-200 overflow-hidden">
          <div class="p-3 bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-600 flex justify-between">
            <span>数据样例预览（展示前 15 行）</span>
            <span>合格数据将作为入库依据</span>
          </div>
          <div class="max-h-72 overflow-y-auto">
            <table class="w-full text-left text-xs">
              <thead class="bg-white border-b border-slate-100 text-slate-400 font-bold sticky top-0">
                <tr>
                  <th class="py-2.5 px-3">行号</th>
                  <th class="py-2.5 px-3">会员姓名</th>
                  <th class="py-2.5 px-3">手机号码</th>
                  <th class="py-2.5 px-3">本金余额</th>
                  <th class="py-2.5 px-3">预检状态</th>
                  <th class="py-2.5 px-3">检测分析结果</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 font-medium">
                <tr
                  v-for="item in validationReport.results.slice(0, 15)"
                  :key="item.rowNum"
                  :class="{
                    'bg-emerald-50/30': item.status === 'valid_new',
                    'bg-amber-50/30': item.status === 'conflict',
                    'bg-rose-50/40': item.status === 'invalid'
                  }"
                >
                  <td class="py-2.5 px-3 font-mono text-slate-400">#{{ item.rowNum }}</td>
                  <td class="py-2.5 px-3 font-bold text-slate-900">{{ item.data.name || '—' }}</td>
                  <td class="py-2.5 px-3 font-mono font-bold">{{ item.data.phone || '—' }}</td>
                  <td class="py-2.5 px-3 font-black tabular-nums">¥{{ (item.data.balanceCents / 100).toFixed(2) }}</td>
                  <td class="py-2.5 px-3">
                    <span
                      class="px-2 py-0.5 rounded text-[11px] font-bold"
                      :class="{
                        'bg-emerald-100 text-emerald-800': item.status === 'valid_new',
                        'bg-amber-100 text-amber-800': item.status === 'conflict',
                        'bg-rose-100 text-rose-800': item.status === 'invalid'
                      }"
                    >
                      {{ item.status === 'valid_new' ? '正常新会员' : item.status === 'conflict' ? '重复冲突' : '格式异常' }}
                    </span>
                  </td>
                  <td class="py-2.5 px-3 text-slate-500" :class="{ 'text-rose-600 font-bold': item.status === 'invalid' }">
                    {{ item.reason }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 步骤5：正式入库提交 -->
        <div class="pt-4 flex flex-wrap items-center justify-between gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-200">
          <div>
            <div class="text-sm font-black text-slate-900">
              准备就绪：共 {{ commitTargetCount }} 条记录即将安全入库
            </div>
            <div class="text-xs text-slate-500 mt-0.5">
              已自动备份安全快照，入库过程中保证原子性与防重复提交。
            </div>
          </div>

          <button
            @click="executeImport"
            :disabled="commitTargetCount === 0 || isImporting"
            class="h-12 px-8 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800 text-white rounded-xl text-sm font-black shadow-lg shadow-emerald-700/25 transition btn-press disabled:opacity-40 flex items-center gap-2"
          >
            <span v-if="isImporting" class="animate-spin text-base">⏳</span>
            <span>{{ isImporting ? `正在安全入库 (${importProgress}%)...` : '确认入库至系统账本' }}</span>
          </button>
        </div>

        <!-- 进度条 -->
        <div v-if="isImporting" class="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
          <div
            class="bg-emerald-600 h-2.5 rounded-full transition-all duration-300"
            :style="{ width: `${importProgress}%` }"
          ></div>
        </div>
      </div>
    </div>

    <!-- 底部：全量数据导出中心 -->
    <div class="bg-white rounded-3xl border border-slate-200/80 shadow-sm p-6 space-y-4">
      <h3 class="font-black text-slate-900 text-base flex items-center gap-2 border-b border-slate-100 pb-3">
        <span>📤</span> 门店数据导出备份中心 (Excel 格式)
      </h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="p-5 rounded-2xl border border-slate-200 bg-slate-50/60 flex flex-col justify-between">
          <div>
            <div class="text-sm font-black text-slate-800">全量会员档案表</div>
            <div class="text-xs text-slate-500 mt-1">包含所有在用与归档会员的姓名、手机号、卡内本金余额、欠款及备注。</div>
          </div>
          <button
            @click="exportMembers"
            class="mt-4 h-10 w-full bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5"
          >
            <span>📥</span> 导出会员 Excel
          </button>
        </div>

        <div class="p-5 rounded-2xl border border-slate-200 bg-slate-50/60 flex flex-col justify-between">
          <div>
            <div class="text-sm font-black text-slate-800">财务流水对账总单</div>
            <div class="text-xs text-slate-500 mt-1">包含所有消费扣款、充值储值入账及冲正撤销明细，自带防注入过滤。</div>
          </div>
          <button
            @click="exportLedgers"
            class="mt-4 h-10 w-full bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5"
          >
            <span>📥</span> 导出流水 Excel
          </button>
        </div>

        <div class="p-5 rounded-2xl border border-slate-200 bg-slate-50/60 flex flex-col justify-between">
          <div>
            <div class="text-sm font-black text-slate-800">系统安全审计日志</div>
            <div class="text-xs text-slate-500 mt-1">导出店员账号登录历史、权限变更、敏感操作追溯记录，供合规审计。</div>
          </div>
          <button
            @click="exportAudit"
            class="mt-4 h-10 w-full bg-white hover:bg-slate-100 border border-slate-300 text-slate-800 rounded-xl text-xs font-black transition flex items-center justify-center gap-1.5"
          >
            <span>📥</span> 导出审计日志
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { adminApi } from '../api/client.js';
import {
  parseUploadedFile,
  validateImportBatch,
  downloadImportTemplate,
  downloadErrorReport
} from '../utils/importer.js';
import {
  exportMembersToExcel,
  exportLedgersToExcel,
  exportAuditLogsToExcel
} from '../utils/exporter.js';

const props = defineProps({
  members: { type: Array, default: () => [] },
  ledgers: { type: Array, default: () => [] }
});

const emit = defineEmits(['refresh-data']);

const fileInputRef = ref(null);
const currentFile = ref(null);
const isDragging = ref(false);
const parseResult = ref(null);
const customMapping = ref({ name: null, phone: null, balance: null, gift: null, remark: null, tag: null });
const conflictStrategy = ref('skip');
const isValidating = ref(false);
const validationReport = ref(null);
const isImporting = ref(false);
const importProgress = ref(0);

const fieldDefinitions = {
  name: { label: '会员姓名', required: true },
  phone: { label: '手机号码', required: true },
  balance: { label: '可用本金余额', required: false },
  gift: { label: '赠送金', required: false },
  remark: { label: '备注说明', required: false },
  tag: { label: '会员标签', required: false }
};

const commitTargetCount = computed(() => {
  if (!validationReport.value) return 0;
  if (conflictStrategy.value === 'skip') {
    return validationReport.value.validCount;
  }
  return validationReport.value.validCount + validationReport.value.conflictCount;
});

function triggerFileInput() {
  fileInputRef.value?.click();
}

async function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (file) await processFile(file);
}

async function handleFileDrop(e) {
  isDragging.value = false;
  const file = e.dataTransfer.files?.[0];
  if (file) await processFile(file);
}

async function processFile(file) {
  currentFile.value = file;
  validationReport.value = null;
  try {
    const res = await parseUploadedFile(file);
    parseResult.value = res;
    customMapping.value = { ...res.mapping };
  } catch (err) {
    alert(err.message || '文件解析失败，请检查文件格式');
    resetUpload();
  }
}

function resetUpload() {
  currentFile.value = null;
  parseResult.value = null;
  validationReport.value = null;
  if (fileInputRef.value) fileInputRef.value.value = '';
}

function runValidation() {
  if (!parseResult.value) return;
  isValidating.value = true;
  try {
    const report = validateImportBatch(
      parseResult.value.dataRows,
      customMapping.value,
      props.members,
      { conflictStrategy: conflictStrategy.value }
    );
    validationReport.value = report;
  } finally {
    isValidating.value = false;
  }
}

function downloadTemplate() {
  downloadImportTemplate();
}

function downloadErrors() {
  if (!validationReport.value) return;
  const invalids = validationReport.value.results.filter(r => r.status === 'invalid');
  downloadErrorReport(invalids, parseResult.value.headers);
}

async function executeImport() {
  if (!validationReport.value) return;

  const validItems = validationReport.value.results.filter(r => {
    if (r.status === 'valid_new') return true;
    if (r.status === 'conflict' && conflictStrategy.value !== 'skip') return true;
    return false;
  });

  if (!validItems.length) {
    alert('没有可入库的合规有效记录');
    return;
  }

  isImporting.value = true;
  importProgress.value = 0;

  try {
    const result = await adminApi.executeBatchImport(
      validItems,
      conflictStrategy.value,
      progress => {
        importProgress.value = progress;
      }
    );

    alert(`🎉 恭喜！成功入库 ${result.count} 笔会员数据！数据已实时同步。`);
    resetUpload();
    emit('refresh-data');
  } catch (err) {
    alert('入库执行失败: ' + (err.message || '请检查网络或联系管理员'));
  } finally {
    isImporting.value = false;
    importProgress.value = 0;
  }
}

// 导出中心方法
function exportMembers() {
  exportMembersToExcel(props.members, '梦飞空间全量会员档案');
}

function exportLedgers() {
  exportLedgersToExcel(props.ledgers, '梦飞空间全量财务流水');
}

async function exportAudit() {
  try {
    const logs = await adminApi.getActivity();
    exportAuditLogsToExcel(logs, '梦飞空间系统安全审计日志');
  } catch (err) {
    alert('获取审计日志失败: ' + err.message);
  }
}
</script>
