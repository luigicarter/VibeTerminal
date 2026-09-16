'use strict';
const http = require('node:http'),
  { randomBytes, createHash } = require('node:crypto');
const secret = () => randomBytes(32).toString('base64url');
function createLoginFlow({
  transport,
  openBrowser,
  installationId,
  platform,
  appVersion,
  onSession,
}) {
  let attempt = null,
    generation = 0,
    failure = null;
  async function close(current) {
    if (current?.timer) clearTimeout(current.timer);
    if (current?.server) await new Promise((r) => current.server.close(r));
  }
  async function cancel() {
    const previous = attempt;
    attempt = null;
    failure = null;
    generation++;
    if (previous) {
      previous.abort.abort();
      await close(previous);
      if (previous.id)
        await transport
          .request('POST', '/api/desktop-auth/cancel', {
            attemptId: previous.id,
            cancelSecret: previous.cancelSecret,
          })
          .catch(() => {});
    }
  }
  async function exchange(input, current) {
    if (
      current !== attempt ||
      current.busy ||
      input.attempt !== current.id ||
      input.state !== current.state ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.code || '')
    )
      throw Error('callback_invalid');
    current.busy = true;
    let exchanged = false;
    try {
      const result = await transport.request(
        'POST',
        '/api/desktop-auth/exchange',
        {
          attemptId: current.id,
          code: input.code,
          state: current.state,
          verifier: current.verifier,
        },
        current.abort.signal,
      );
      if (current !== attempt) {
        transport.clear();
        throw Error('login_cancelled');
      }
      exchanged = true;
      await onSession(result);
      failure = null;
      attempt = null;
      generation++;
      await close(current);
      return result;
    } catch (error) {
      current.busy = false;
      if (current === attempt) {
        const code = error.code || error.message;
        failure = /^[a-z_]{1,80}$/.test(code || '') ? code : 'login_failed';
        if (exchanged) {
          attempt = null;
          generation++;
          await close(current);
        }
      }
      throw error;
    }
  }
  async function start() {
    await cancel();
    const version = ++generation;
    const current = {
      state: secret(),
      verifier: secret(),
      path: '/lina-login/' + secret(),
      abort: new AbortController(),
      busy: false,
    };
    attempt = current;
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      const expected = `127.0.0.1:${server.address()?.port}`;
      if (
        req.method !== 'GET' ||
        req.headers.host !== expected ||
        req.socket.remoteAddress !== '127.0.0.1'
      ) {
        res.writeHead(400).end('Invalid callback');
        return;
      }
      let url;
      try {
        url = new URL(req.url, `http://${expected}`);
      } catch {
        res.writeHead(400).end('Invalid callback');
        return;
      }
      if (
        url.origin !== `http://${expected}` ||
        url.pathname !== current.path ||
        [...url.searchParams.keys()].sort().join(',') !== 'attempt,code,state'
      ) {
        res.writeHead(400).end('Invalid callback');
        return;
      }
      // Complete response before closing listener; server.close waits for sockets.
      try {
        const input = Object.fromEntries(url.searchParams);
        if (
          input.state !== current.state ||
          input.attempt !== current.id ||
          current !== attempt
        ) {
          res.writeHead(400).end('Invalid callback');
          return;
        }
        res
          .writeHead(200, { 'Content-Type': 'text/plain' })
          .end('Returning to Lina. You may close this page.');
        await exchange(input, current);
      } catch {
        /* State/error is exposed through the controller, never callback URLs. */
      }
    });
    current.server = server;
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const reply = await transport.request(
        'POST',
        '/api/desktop-auth/start',
        {
          challenge: createHash('sha256')
            .update(current.verifier)
            .digest('base64url'),
          state: current.state,
          callback: `http://127.0.0.1:${server.address().port}${current.path}`,
          installationId,
          platform,
          appVersion,
        },
        current.abort.signal,
      );
      current.id = reply.attemptId;
      current.cancelSecret = reply.cancelSecret;
      if (version !== generation || attempt !== current)
        throw Error('login_cancelled');
      const url = new URL(reply.authorizationUrl);
      if (
        url.origin !== transport.origin ||
        url.pathname !== '/account/desktop-authorization' ||
        url.searchParams.get('attempt') !== current.id ||
        url.username ||
        url.password ||
        url.hash
      )
        throw Error('authorization_url_invalid');
      current.timer = setTimeout(() => {
        if (attempt === current) {
          void cancel();
          failure = 'login_expired';
        }
      }, 600000);
      current.timer.unref();
      await openBrowser(url.href);
      return { waiting: true };
    } catch (error) {
      if (attempt === current) await cancel();
      else await close(current);
      throw error;
    }
  }
  return {
    start,
    cancel,
    submitCode: (code) => {
      if (!attempt) throw Error('login_not_started');
      return exchange(
        { attempt: attempt.id, state: attempt.state, code },
        attempt,
      );
    },
    waiting: () => !!attempt,
    error: () => failure,
  };
}
module.exports = { createLoginFlow };
