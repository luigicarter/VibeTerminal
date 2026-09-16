'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
// No Electron import and no I/O on import/construction. Inject after app.ready.
function createSessionStore({
  file,
  secureStorage,
  platform = process.platform,
}) {
  if (!path.isAbsolute(file)) throw Error('account_store_path_required');
  let memory = null,
    sequence = Promise.resolve();
  const available = () =>
    !!secureStorage?.isEncryptionAvailable?.() &&
    (platform !== 'linux' ||
      !['basic_text', 'unknown', undefined].includes(
        secureStorage.getSelectedStorageBackend?.(),
      ));
  const serialized = (fn) => {
    const next = sequence.then(fn);
    sequence = next.catch(() => {});
    return next;
  };
  function validate(value) {
    if (
      !value ||
      value.version !== 1 ||
      typeof value.cookie !== 'string' ||
      value.cookie.length > 4096 ||
      /[\r\n]/.test(value.cookie) ||
      !/^(__Secure-)?better-auth\.session_token=[^;\s]+$/.test(value.cookie) ||
      typeof value.userId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.deviceId !== 'string'
    )
      throw Error('account_store_invalid');
    return value;
  }
  async function write(value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        secureStorage.encryptString(JSON.stringify(value)),
        { mode: 0o600, flag: 'wx' },
      );
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temporary, file);
          break;
        } catch (error) {
          if (
            !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) ||
            attempt === 4
          )
            throw error;
          await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        }
      }
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
  return {
    mode: () => (available() ? 'encrypted' : 'memory-only'),
    load: () =>
      serialized(async () => {
        if (memory) return structuredClone(memory);
        if (!available()) return null;
        let bytes;
        try {
          bytes = await fs.readFile(file);
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw Error('account_store_unavailable');
        }
        try {
          memory = validate(JSON.parse(secureStorage.decryptString(bytes)));
          return structuredClone(memory);
        } catch {
          throw Error('account_store_unreadable');
        }
      }),
    save: (value) =>
      serialized(async () => {
        const next = structuredClone(validate(value));
        if (available()) {
          try {
            await write(next);
          } catch {
            throw Error('account_store_write_failed');
          }
        }
        memory = next;
        return { persistence: available() ? 'encrypted' : 'memory-only' };
      }),
    clear: () =>
      serialized(async () => {
        memory = null;
        try {
          await fs.unlink(file);
        } catch (error) {
          if (error.code !== 'ENOENT')
            throw Error('account_store_clear_failed');
        }
      }),
  };
}
module.exports = { createSessionStore };
