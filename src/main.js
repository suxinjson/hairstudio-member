import { createApp } from 'vue';
import { Capacitor } from '@capacitor/core';
import App from './App.vue';
import './style.css';
import { configureLedgerAccess, createLedgerPage } from './ledger-access.js';

// 原生窗口已避开系统栏，不再叠加网页端的状态栏占位。
document.documentElement.classList.toggle('native-system-insets', Capacitor.isNativePlatform());
if (Capacitor.isNativePlatform()) createApp(App).mount('#app');
else {
  let app;
  const showStatus = message => {
    const root = document.getElementById('app');
    const notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    notice.className = 'p-8 text-center text-slate-800 bg-white';
    notice.textContent = message;
    root.replaceChildren(notice);
  };
  const page = createLedgerPage({
    onWaiting() { showStatus('账本正在其他页面使用；关闭该页面后，本页会自动加载。'); },
    onAcquire() {
      configureLedgerAccess(page.hasAccess);
      app = createApp(App); app.mount('#app');
    },
    onRelease() {
      configureLedgerAccess(page.hasAccess);
      app?.unmount(); app = null;
    },
    onError(error) { showStatus(error.message); }
  });
  configureLedgerAccess(page.hasAccess);
  page.start();
}
