import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { Pairing } from '../api/types';

/**
 * One small key/value adapter: the device keychain on iOS and Android, and
 * `localStorage` in a browser, where `expo-secure-store` has no implementation.
 * Falls back to process memory so a hostile storage environment degrades to a
 * session-only pairing instead of crashing the app.
 */

const PAIRING_KEY = 'lina.pairing.v1';

const memory = new Map<string, string>();

const isWeb = Platform.OS === 'web';

function webStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export async function readItem(key: string): Promise<string | null> {
  try {
    if (isWeb) {
      const store = webStorage();
      if (store) return store.getItem(key);
      return memory.get(key) ?? null;
    }
    return await SecureStore.getItemAsync(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export async function writeItem(key: string, value: string): Promise<void> {
  memory.set(key, value);
  try {
    if (isWeb) {
      webStorage()?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  } catch {
    /* memory copy already holds it */
  }
}

export async function removeItem(key: string): Promise<void> {
  memory.delete(key);
  try {
    if (isWeb) {
      webStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* nothing else to do */
  }
}

function isPairing(value: unknown): value is Pairing {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Pairing>;
  return (
    typeof candidate.host === 'string' &&
    candidate.host.length > 0 &&
    typeof candidate.port === 'number' &&
    typeof candidate.code === 'string' &&
    candidate.code.length > 0
  );
}

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await readItem(PAIRING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPairing(parsed)) return null;
    return {
      host: parsed.host,
      port: parsed.port,
      code: parsed.code,
      desktopHost: typeof parsed.desktopHost === 'string' ? parsed.desktopHost : parsed.host,
      desktopId: typeof parsed.desktopId === 'string' ? parsed.desktopId : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
      pairedAt: typeof parsed.pairedAt === 'number' ? parsed.pairedAt : 0,
      readOnly: parsed.readOnly === true,
    };
  } catch {
    return null;
  }
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await writeItem(PAIRING_KEY, JSON.stringify(pairing));
}

export async function clearPairing(): Promise<void> {
  await removeItem(PAIRING_KEY);
}
