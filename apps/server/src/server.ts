import { loadConfig } from './config';
import { createPool } from './db';
import { createApp } from './app';
import { log } from './monitoring/log';
const config = loadConfig(),
  pool = createPool(config),
  { app } = createApp(config, pool);
const server = Bun.serve({
  hostname: config.HOST,
  port: config.PORT,
  idleTimeout: 30,
  maxRequestBodySize: 32768,
  fetch(request, server) {
    return app.fetch(request, { peerIp: server.requestIP(request)?.address });
  },
  error() {
    return Response.json(
      { error: { code: 'request_failed' } },
      { status: 500 },
    );
  },
});
log('info', 'server_started');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => {
    server.stop(true);
    process.exit(1);
  }, 10000);
  timeout.unref();
  await server.stop();
  await pool.end();
  clearTimeout(timeout);
  process.exit(0);
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
