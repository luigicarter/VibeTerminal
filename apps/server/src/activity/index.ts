import { z } from 'zod';
import type { Pool } from 'pg';
import { transaction } from '../db';
import { HttpError } from '../http';
export const deviceSchema = z.strictObject({
  installationId: z.uuid(),
  platform: z.enum(['windows', 'macos', 'linux', 'ios', 'android', 'web']),
  appVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/)
    .max(60),
});
export const eventsSchema = z.strictObject({
  deviceId: z.uuid(),
  events: z
    .array(
      z.strictObject({
        eventId: z.uuid(),
        schemaVersion: z.literal(1),
        event: z.enum([
          'terminal.started',
          'agent.started',
          'orchestrator.started',
          'orchestrator.completed',
          'orchestrator.failed',
        ]),
        occurredAt: z.iso.datetime(),
        properties: z.strictObject({
          agent: z
            .enum([
              'codex',
              'claude',
              'gemini',
              'opencode',
              'fusion',
              'openfusion',
              'other',
            ])
            .optional(),
          durationMs: z.number().int().min(0).max(86400000).optional(),
          outcome: z.enum(['completed', 'failed', 'canceled']).optional(),
        }),
      }),
    )
    .min(1)
    .max(50),
});
export async function registerDevice(
  pool: Pool,
  userId: string,
  sessionId: string,
  input: z.infer<typeof deviceSchema>,
) {
  return transaction(pool, async (db) => {
    const result = await db.query(
      'INSERT INTO devices(user_id,installation_id,platform,app_version) VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,installation_id) DO UPDATE SET app_version=excluded.app_version,last_seen_at=now() RETURNING id',
      [userId, input.installationId, input.platform, input.appVersion],
    );
    const deviceId = result.rows[0].id;
    const binding = await db.query(
      'SELECT device_id FROM session_devices WHERE session_id=$1',
      [sessionId],
    );
    if (binding.rows[0] && binding.rows[0].device_id !== deviceId)
      throw new HttpError(409, 'session_already_bound');
    await db.query(
      'INSERT INTO session_devices(session_id,user_id,device_id) VALUES ($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET last_seen_at=now()',
      [sessionId, userId, deviceId],
    );
    return { deviceId };
  });
}
export async function heartbeat(
  pool: Pool,
  userId: string,
  sessionId: string,
  deviceId: string,
) {
  return transaction(pool, async (db) => {
    const result = await db.query(
      'UPDATE session_devices SET last_seen_at=now() WHERE session_id=$1 AND user_id=$2 AND device_id=$3 RETURNING last_seen_at',
      [sessionId, userId, deviceId],
    );
    if (!result.rowCount) throw new HttpError(403, 'device_not_bound');
    await db.query('UPDATE devices SET last_seen_at=now() WHERE id=$1', [
      deviceId,
    ]);
    return { lastSeenAt: result.rows[0].last_seen_at };
  });
}
export async function ingest(
  pool: Pool,
  userId: string,
  sessionId: string,
  input: z.infer<typeof eventsSchema>,
) {
  return transaction(pool, async (db) => {
    const bound = await db.query(
      'SELECT 1 FROM session_devices WHERE session_id=$1 AND user_id=$2 AND device_id=$3',
      [sessionId, userId, input.deviceId],
    );
    if (!bound.rowCount) throw new HttpError(403, 'device_not_bound');
    const now = (await db.query('SELECT now() AS time')).rows[0].time.getTime();
    let accepted = 0;
    for (const e of input.events) {
      const time = new Date(e.occurredAt).getTime();
      if (time > now + 300000 || time < now - 86400000)
        throw new HttpError(400, 'event_time_out_of_range');
      const dedupe = await db.query(
        'INSERT INTO activity_dedupe(user_id,event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',
        [userId, e.eventId],
      );
      if (!dedupe.rowCount) continue;
      await db.query(
        'INSERT INTO activity_events(user_id,session_id,device_id,event_id,schema_version,event,properties,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          userId,
          sessionId,
          input.deviceId,
          e.eventId,
          e.schemaVersion,
          e.event,
          e.properties,
          e.occurredAt,
        ],
      );
      accepted++;
    }
    return {
      accepted,
      duplicates: input.events.length - accepted,
      source: 'client_reported',
    };
  });
}
