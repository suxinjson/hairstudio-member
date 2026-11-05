import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/admin/',
  plugins: [
    vue(),
    tailwindcss()
  ],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:48927',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/xlsx') || id.includes('xlsx')) return 'xlsx';
          if (id.includes('node_modules/vue')) return 'vue';
          if (id.includes('node_modules/lucide-vue-next')) return 'icons';
        }
      }
    }
  }
});
