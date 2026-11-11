import { ref, getCurrentScope, onScopeDispose } from 'vue';
import { DATA_LIMITS } from '../data-limits.js';
import { exportFile, isExportCancelled } from '../file-export.js';
import { storeFilePrefix } from '../store-profile.js';

export function useBackupOperations({
  localDb,
  cloudClient,
  refreshAll,
  selectedMember,
  consumingMember,
  rechargingMember,
  showToast,
  showFeedback,
  askConfirm
}) {
  const isExporting = ref(false);
  const backupRestoreRequest = ref(null);
  const isRestoringBackup = ref(false);
  const restoreMode = ref('merge');
  const localSnapshots = ref([]);
  let currentReader = null, readGeneration = 0;
  function cancelRead() {
    readGeneration++;
    const old = currentReader; currentReader = null;
    if (old?.readyState === 1) old.abort();
  }
  if (getCurrentScope()) onScopeDispose(cancelRead);

  function showExportResult(result, extra = '') {
    const message = result.kind === 'shared'
      ? `已完成系统分享（${result.fileName}），请确认接收端文件可打开。`
      : `已发起文件下载（${result.fileName}），请在浏览器下载记录中确认保存结果。`;
    showFeedback(`${message}${extra}`, 'success', { title: '文件导出' });
  }

  // 微信/手机一键备份导出
  async function handleExportBackup() {
    if (isExporting.value) return;
    isExporting.value = true;
    try {
      const recovery = localDb.readRecoveryState();
      if (recovery.dataError) {
        const result = await exportFile({
          content: JSON.stringify({ version: '2.0', exportedAt: new Date().toISOString(), appName: '会员管家', ...recovery }, null, 2),
          fileName: `${storeFilePrefix(cloudClient.getStoreProfile())}_账本原始数据_${new Date().toISOString().slice(0, 10)}.json`,
          mimeType: 'application/json',
          title: '账本原始数据备份'
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
      const result = await exportFile({
        content,
        fileName: `${storeFilePrefix(cloudClient.getStoreProfile())}_会员账本备份_${dateStr}.json`,
        mimeType: 'application/json',
        title: '会员账本备份'
      });
      showExportResult(result, snapshotWarning);
    } catch (err) {
      if (!isExportCancelled(err)) {
        showFeedback(err.message, 'error', { title: '备份导出失败' });
      }
    } finally {
      isExporting.value = false;
    }
  }

  async function handleExportCSV() {
    if (isExporting.value) return;
    isExporting.value = true;
    try {
      const csv = localDb.exportCSV();
      const dateStr = new Date().toISOString().split('T')[0];
      const result = await exportFile({
        content: csv,
        fileName: `${storeFilePrefix(cloudClient.getStoreProfile())}_对账明细_${dateStr}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        title: '对账明细'
      });
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
  async function handleDeleteSnapshot(id) {
    const confirmed = await askConfirm({
      title: '删除快照确认',
      message: '确定要删除此份本地快照记录吗？\n删除后将无法从此快照点恢复数据。',
      confirmText: '确认删除',
      cancelText: '取消',
      danger: true
    });
    if (!confirmed) return;
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
      const result = await exportFile({
        content: s.content,
        fileName: s.fileName,
        mimeType: 'application/json',
        title: '会员账本备份'
      });
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
    cancelRead();
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
    cancelRead();
    if (!file) return;
    if (file.size > DATA_LIMITS.backupBytes) {
      input.value = '';
      showFeedback('备份文件超过 20 MiB 限制，请选择较小的有效备份。', 'error', { title: '备份读取失败' });
      return;
    }
    const generation = readGeneration;
    const reader = new FileReader();
    currentReader = reader;
    reader.onload = (event) => {
      if (generation !== readGeneration) return;
      currentReader = null;
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
      if (generation !== readGeneration) return;
      currentReader = null;
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
      if (selectedMember) selectedMember.value = null;
      if (consumingMember) consumingMember.value = null;
      if (rechargingMember) rechargingMember.value = null;
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

  return {
    isExporting,
    backupRestoreRequest,
    isRestoringBackup,
    restoreMode,
    localSnapshots,
    handleExportBackup,
    handleExportCSV,
    handleCreateManualSnapshot,
    handleDeleteSnapshot,
    handleShareSnapshot,
    handleRestoreSnapshot,
    handleImportBackup,
    confirmBackupRestore
  };
}
