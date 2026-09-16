'use strict';
const specs = {
  status: [() => true, (c) => c.snapshot()],
  refresh: [() => true, (c) => c.refresh()],
  login: [() => true, (c) => c.startLogin()],
  cancel: [() => true, (c) => c.cancelLogin()],
  logout: [() => true, (c) => c.logout()],
  sessions: [() => true, (c) => c.sessions()],
  preferences: [() => true, (c) => c.preferences()],
  portal: [() => true, (c) => c.portal()],
  billing: [() => true, (c) => c.billingStatus()],
  code: [
    (p) => typeof p.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(p.code),
    (c, p) => c.submitCode(p.code),
  ],
  revoke: [
    (p) => typeof p.id === 'string' && /^[0-9a-f-]{36}$/.test(p.id),
    (c, p) => c.revokeSession(p.id),
  ],
  usage: [
    (p) => typeof p.enabled === 'boolean',
    (c, p) => c.setUsage(p.enabled),
  ],
  checkout: [
    (p) =>
      ['full_access', 'orchestrator'].includes(p.tier) &&
      ['month', 'year'].includes(p.interval),
    (c, p) => c.checkout(p),
  ],
};
const fields = {
  code: ['code'],
  revoke: ['id'],
  usage: ['enabled'],
  checkout: ['tier', 'interval'],
};
// Explicit installer for the isolated harness only. No registration on import.
function installAccountIpc({
  ipcMain,
  controller,
  getWindow,
  trustedRendererUrl,
}) {
  if (typeof trustedRendererUrl !== 'string' || !trustedRendererUrl)
    throw Error('account_renderer_url_required');
  const channels = [];
  for (const [name, [validate, run]] of Object.entries(specs)) {
    const channel = 'account-prepared:' + name;
    channels.push(channel);
    ipcMain.handle(channel, async (event, payload = {}) => {
      const window = getWindow();
      if (
        !window ||
        window.isDestroyed() ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== trustedRendererUrl
      )
        throw Error('account_caller_forbidden');
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.keys(payload).some(
          (key) => !(fields[name] || []).includes(key),
        ) ||
        !validate(payload)
      )
        throw Error('account_input_invalid');
      return run(controller, payload);
    });
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
module.exports = { installAccountIpc };
