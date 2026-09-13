import type { Context } from 'hono';
import type { z } from 'zod';
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid_input');
  return parsed.data;
}
export function uuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new HttpError(400, 'invalid_id');
  return value;
}
export function page(c: Context) {
  const limit = Number(c.req.query('limit') || 25),
    offset = Number(c.req.query('offset') || 0);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 100000
  )
    throw new HttpError(400, 'invalid_pagination');
  return { limit, offset };
}
