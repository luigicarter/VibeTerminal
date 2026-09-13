import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadConfig } from '../src/config';
import { createPool } from '../src/db';
import { spawnSync } from 'node:child_process';
export function pgCommand(name: string) {
  return process.env.PG_BIN
    ? join(
        process.env.PG_BIN,
        name + (process.platform === 'win32' ? '.exe' : ''),
      )
    : process.platform === 'win32'
      ? join('C:/Program Files/PostgreSQL/17/bin', name + '.exe')
      : name;
}
export async function runPg(name: string, url: string, args: string[]) {
  const connection = new URL(url),
    password = decodeURIComponent(connection.password);
  connection.password = '';
  // Dedicated maintenance commands, never HTTP handlers. Synchronous process
  // collection avoids a reproduced Windows async-pipe hang in PostgreSQL tools.
  const child = spawnSync(
    pgCommand(name),
    ['--dbname', connection.href, ...args],
    {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 300000,
    },
  );
  if (child.status !== 0)
    throw new Error(
      name +
        ' failed; verify PostgreSQL client version, connectivity and permissions.',
    );
}
export async function backupDatabase(url: string, directory: string) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const file = join(
    target,
    'lina-' + new Date().toISOString().replace(/[:.]/g, '-') + '.dump',
  );
  await runPg('pg_dump', url, [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    '--file',
    file,
  ]);
  await chmod(file, 0o600);
  return file;
}
if (import.meta.main) {
  const config = loadConfig(),
    pool = createPool(config);
  try {
    await backupDatabase(
      config.DATABASE_URL,
      process.env.BACKUP_DIR || resolve(import.meta.dir, '../backups'),
    );
    await pool.query(
      "INSERT INTO job_status(name,last_success_at) VALUES('backup_local',now()) ON CONFLICT(name) DO UPDATE SET last_success_at=now()",
    );
    console.log(
      'Local database snapshot completed. Off-VM backup is not recorded until its upload is verified.',
    );
  } catch {
    console.error('Database backup failed.');
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
