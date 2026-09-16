import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  build: {
    outDir: '.tmp/account-prepared-harness',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'account-prepared-harness.html'),
    },
  },
});
