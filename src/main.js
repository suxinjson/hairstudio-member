import { createApp } from 'vue';
import { Capacitor } from '@capacitor/core';

// 原生窗口已避开系统栏，不再叠加网页端的状态栏占位。
const native = Capacitor.isNativePlatform();
document.documentElement.classList.toggle('native-system-insets', native);
if (!native) {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1.0');
  document.body.classList.remove('select-none');
}

// 根路径保留收银界面；浏览器由在线客户端加载服务器账本。
// /admin/ 由独立的后台入口提供，原生 App 继续使用离线账本。
Promise.all([import('./App.vue'), import('./style.css')])
  .then(([{ default: App }]) => createApp(App).mount('#app')).catch(error => {
    console.error('应用加载失败:', error);
    const root = document.getElementById('app');
    root.setAttribute('role', 'alert');
    root.textContent = '应用加载失败，请刷新页面重试。';
  });
