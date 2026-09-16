'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
// Random identifier, not a hardware fingerprint. No I/O until explicit init.
function createInstallationStore(file) {
  if (!path.isAbsolute(file)) throw Error('installation_path_required');
  const read = async () => {
    const id = (await fs.readFile(file, 'utf8')).trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw Error('installation_id_invalid');
    return id;
  };
  return {
    async loadOrCreate() {
      try {
        return await read();
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = file + '.' + randomUUID() + '.tmp',
        id = randomUUID();
      try {
        await fs.writeFile(temporary, id + '\n', { flag: 'wx', mode: 0o600 });
        try {
          await fs.link(temporary, file);
          return id;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          return await read();
        }
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    },
  };
}
module.exports = { createInstallationStore };
