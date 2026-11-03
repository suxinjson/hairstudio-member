import { createApp } from 'vue';
import { Capacitor } from '@capacitor/core';
import App from './App.vue';
import './style.css';

// 原生窗口已避开系统栏，不再叠加网页端的状态栏占位。
document.documentElement.classList.toggle('native-system-insets', Capacitor.isNativePlatform());
createApp(App).mount('#app');
