import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "../config/env.js";
import type { WaitlistResponse } from "../types/api.js";
import type { WaitlistEntry } from "../types/waitlist.js";
import { createHttpError } from "../utils/httpError.js";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The file-backed deployment has one writer process. Serialize complete
// read/modify/write operations so concurrent requests cannot lose signups.
let pendingWrite: Promise<void> = Promise.resolve();

const readEntries = async (): Promise<WaitlistEntry[]> => {
  let raw: string;
  try {
    raw = await readFile(env.waitlistFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  try {
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.some(entry => !entry ||
      typeof entry.email !== "string" || typeof entry.source !== "string" ||
      typeof entry.submittedAt !== "string")) throw new Error("Invalid signup store");
    return entries;
  } catch {
    throw createHttpError(500, "Waitlist store is invalid and has been preserved");
  }
};

const writeEntries = async (entries: WaitlistEntry[]) => {
  await mkdir(path.dirname(env.waitlistFilePath), { recursive: true });
  const temporary = `${env.waitlistFilePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, env.waitlistFilePath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
};

export const captureWaitlistEmail = async (email: unknown, source: unknown = "website"): Promise<WaitlistResponse> => {
  if (typeof email !== "string" || typeof source !== "string") {
    throw createHttpError(400, "Email and source must be text");
  }
  const normalizedEmail = email.trim().toLowerCase();

  if (normalizedEmail.length > 254 || !emailPattern.test(normalizedEmail)) {
    throw createHttpError(400, "Enter a valid email address");
  }

  const save = async (): Promise<WaitlistResponse> => {
    const entries = await readEntries();
    const existingEntry = entries.find((entry) => entry.email === normalizedEmail);

    if (existingEntry) {
      return {
        email: existingEntry.email,
        status: "already_joined",
        submittedAt: existingEntry.submittedAt
      };
    }

    const entry: WaitlistEntry = {
      email: normalizedEmail,
      source: source.slice(0, 80),
      submittedAt: new Date().toISOString()
    };

    await writeEntries([...entries, entry]);

    return {
      email: entry.email,
      status: "joined",
      submittedAt: entry.submittedAt
    };
  };
  const result = pendingWrite.then(save);
  pendingWrite = result.then(() => {}, () => {});
  return result;
};
