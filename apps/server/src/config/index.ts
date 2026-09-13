import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { z } from 'zod';
import { join, resolve } from 'node:path';
import { serverRoot } from '../paths';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  PUBLIC_URL: z.string().url().default('http://127.0.0.1:3002'),
  AUTH_SECRET: z.string().min(32),
  OUTBOX_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  METRICS_TOKEN: z.string().min(32),
  TRUSTED_ORIGINS: z.string().default(''),
  TRUSTED_PROXY_IPS: z.string().default(''),
  SIGNUP_ENABLED: bool.default(false),
  USAGE_ENABLED: bool.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(2).max(50).default(10),
  EMAIL_MODE: z.enum(['smtp', 'disabled', 'test']).default('disabled'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool.default(false),
  EMAIL_FROM: z.string().optional(),
});
export type Config = z.infer<typeof schema> & {
  origins: string[];
  proxyIps: string[];
};
export function parseConfig(input: Record<string, unknown>): Config {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new Error(
      'Invalid server configuration: ' +
        [...new Set(result.error.issues.map((i) => i.path[0]))].join(', '),
    );
  const c = result.data;
  const publicUrl = new URL(c.PUBLIC_URL);
  if (
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== '/' ||
    !['http:', 'https:'].includes(publicUrl.protocol)
  )
    throw new Error('PUBLIC_URL must be a public HTTP(S) origin');
  if (
    ![c.DATABASE_URL, c.MIGRATION_DATABASE_URL]
      .filter(Boolean)
      .every((u) => /^postgres(ql)?:\/\//.test(u!))
  )
    throw new Error('Database configuration must use PostgreSQL');
  const origins = [
    ...new Set([
      new URL(c.PUBLIC_URL).origin,
      ...c.TRUSTED_ORIGINS.split(',').filter(Boolean),
    ]),
  ];
  if (origins.some((o) => new URL(o).origin !== o || new URL(o).username))
    throw new Error('Trusted origins must be exact origins');
  if (c.EMAIL_MODE === 'test' && c.NODE_ENV !== 'test')
    throw new Error('Test email is restricted to tests');
  if (c.EMAIL_MODE === 'smtp' && (!c.SMTP_HOST || !c.EMAIL_FROM))
    throw new Error('SMTP_HOST and EMAIL_FROM are required');
  if (c.SIGNUP_ENABLED && c.EMAIL_MODE === 'disabled')
    throw new Error('Signup requires email delivery');
  if (
    c.NODE_ENV === 'production' &&
    (origins.some((o) => !o.startsWith('https://')) || c.EMAIL_MODE !== 'smtp')
  )
    throw new Error('Production requires HTTPS and SMTP delivery');
  return {
    ...c,
    origins,
    proxyIps: c.TRUSTED_PROXY_IPS.split(',').filter(Boolean),
  };
}
export function loadConfig(): Config {
  const location = join(serverRoot, '.env');
  // Explicit app-owned file; launch Bun with --no-env-file to avoid implicit loading.
  const values: Record<string, unknown> = {
    ...(existsSync(location) ? parse(readFileSync(location)) : {}),
    ...process.env,
  };
  for (const key of [
    'DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'AUTH_SECRET',
    'OUTBOX_KEY',
    'METRICS_TOKEN',
    'SMTP_PASSWORD',
  ]) {
    if (values[key + '_FILE'])
      values[key] = readFileSync(
        resolve(serverRoot, String(values[key + '_FILE'])),
        'utf8',
      ).trim();
  }
  return parseConfig(values);
}
