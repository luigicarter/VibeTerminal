import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'account-preview-home',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/') request.url = '/account-preview.html';
          next();
        });
      },
    },
  ],
  base: './',
  server: { host: '127.0.0.1', port: 5185, strictPort: true },
  build: {
    outDir: '.tmp/account-preview',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./account-preview.html', import.meta.url)),
    },
  },
});
