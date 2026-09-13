import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import type { Config } from '../config';
import { transaction } from '../db';
export type Email = { to: string; subject: string; text: string };
function encrypt(config: Config, value: Email) {
  const iv = randomBytes(12),
    cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(config.OUTBOX_KEY, 'hex'),
      iv,
    );
  const content = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64');
}
function decrypt(config: Config, value: string): Email {
  const bytes = Buffer.from(value, 'base64'),
    decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(config.OUTBOX_KEY, 'hex'),
      bytes.subarray(0, 12),
    );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString(),
  );
}
export async function queueEmail(
  pool: Pool,
  config: Config,
  userId: string,
  to: string,
  kind: 'verify' | 'reset',
  url: string,
  ttl: number,
) {
  if (config.EMAIL_MODE === 'disabled')
    throw new Error('Email delivery unavailable');
  const email = {
    to,
    subject:
      kind === 'verify'
        ? 'Verify your Lina account'
        : 'Reset your Lina password',
    text: `Open this link to ${kind === 'verify' ? 'verify your email' : 'reset your password'}:\n${url}\nThis link expires shortly. If you did not request this, ignore this email.`,
  };
  await pool.query(
    "INSERT INTO email_outbox(id,user_id,payload,expires_at) VALUES ($1,$2,$3,now()+$4*interval '1 second')",
    [randomUUID(), userId, encrypt(config, email), ttl],
  );
}
export async function deliverEmails(
  pool: Pool,
  config: Config,
  testSink?: (email: Email) => Promise<void>,
) {
  const smtp =
    config.EMAIL_MODE === 'smtp'
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE,
          requireTLS: !config.SMTP_SECURE,
          auth: config.SMTP_USER
            ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
            : undefined,
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 10000,
        })
      : null;
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    const row = await transaction(pool, async (db) => {
      const result = await db.query(
        'SELECT * FROM email_outbox WHERE processed_at IS NULL AND expires_at > now() AND next_attempt_at <= now() AND attempts < 8 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1',
      );
      if (!result.rows[0]) return null;
      await db.query(
        "UPDATE email_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '60 seconds' WHERE id=$1",
        [result.rows[0].id],
      );
      return result.rows[0];
    });
    if (!row) break;
    try {
      const email = decrypt(config, row.payload);
      if (
        config.EMAIL_MODE === 'test' &&
        config.NODE_ENV === 'test' &&
        testSink
      )
        await testSink(email);
      else if (smtp)
        await smtp.sendMail({
          ...email,
          from: config.EMAIL_FROM,
          messageId: `<${row.id}@lina-account>`,
        });
      else throw new Error('Email not configured');
      await pool.query(
        'UPDATE email_outbox SET processed_at=now(),payload=NULL,last_error=NULL WHERE id=$1',
        [row.id],
      );
      sent++;
    } catch {
      await pool.query(
        "UPDATE email_outbox SET last_error='delivery_failed',next_attempt_at=now()+least(3600,power(2,attempts)*30)*interval '1 second' WHERE id=$1",
        [row.id],
      );
    }
  }
  smtp?.close();
  await pool.query(
    "UPDATE email_outbox SET payload=NULL,processed_at=now(),last_error='expired' WHERE processed_at IS NULL AND expires_at <= now()",
  );
  return sent;
}
