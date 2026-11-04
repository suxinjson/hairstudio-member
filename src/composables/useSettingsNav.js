import { ref, computed } from 'vue';

export function useSettingsNav({ activeTab, cloudState, isNativeApp }) {
  const settingsPath = ref([]);
  const settingsPage = computed(() => settingsPath.value.at(-1) || 'overview');

  const settingsTitles = {
    account: '账号与同步',
    services: '服务与价格',
    backup: '数据备份',
    'backup-files': '导出与恢复',
    snapshots: '本地快照',
    'file-guide': '文件保存指南',
    users: '账号管理',
    activity: '使用记录',
    update: '应用更新',
    help: '使用帮助'
  };

  const backupEntries = [
    { page: 'backup-files', title: '导出与恢复', description: '备份完整账本、导出 Excel、恢复备份', icon: '📤' },
    { page: 'snapshots', title: '本地快照', description: '归档、查看与恢复手机内的账本快照', icon: '📁' },
    ...(isNativeApp ? [{ page: 'file-guide', title: '文件保存指南', description: '保存到文件管理器或微信', icon: '📄' }] : [])
  ];

  const settingsGroups = computed(() => [
    { title: '日常经营', items: [{ page: 'services', title: '服务与价格', description: '管理理发项目与默认价格', icon: '💈' }] },
    {
      title: '账号与云端',
      items: [
        { page: 'account', title: '账号与同步', description: '登录、同步状态与离线待办', icon: '☁️' },
        ...(cloudState.value.user?.role === 'owner'
          ? [
              { page: 'users', title: '账号管理', description: '店员账号、权限与停用', icon: '👥' },
              { page: 'activity', title: '使用记录', description: '查看门店最近操作', icon: '📋' }
            ]
          : [])
      ]
    },
    { title: '数据安全', items: [{ page: 'backup', title: '数据备份', description: '导出恢复、本地快照与保存指南', icon: '🛡️' }] },
    {
      title: '应用',
      items: [
        { page: 'update', title: '应用更新', description: '检查并安装新版本', icon: '⬆️' },
        { page: 'help', title: '使用帮助', description: '离线记账、同步与备份说明', icon: '💡' }
      ]
    }
  ]);

  function openSettings(page = 'overview') {
    activeTab.value = 'settings';
    settingsPath.value = page === 'overview' ? [] : backupEntries.some((entry) => entry.page === page) ? ['backup', page] : [page];
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

  return {
    settingsPath,
    settingsPage,
    settingsTitles,
    backupEntries,
    settingsGroups,
    openSettings,
    openSettingsPage,
    backInSettings
  };
}
