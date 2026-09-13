import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Separate entry points and output: never part of the marketing site's build.
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'account-preview-home',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/') request.url = '/admin-preview.html';
          next();
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 5186, strictPort: true },
  build: {
    outDir: '../.tmp/account-preview',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        account: fileURLToPath(
          new URL('./account-preview.html', import.meta.url),
        ),
        administration: fileURLToPath(
          new URL('./admin-preview.html', import.meta.url),
        ),
      },
    },
  },
});
