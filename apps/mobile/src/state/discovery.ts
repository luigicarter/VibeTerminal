import Constants from 'expo-constants';
import * as Network from 'expo-network';
import { Platform } from 'react-native';

import { discover } from '../api/client';
import type { Endpoint } from '../api/types';
import { seedCandidates, subnetCandidates, subnetLabel } from './candidates';

/**
 * Find every desktop that answers `/api/discover`, without asking the user for
 * an address.
 *
 * Two passes: the handful of addresses worth trying first (the Metro host, the
 * Android emulator alias, localhost), then — on a phone only — the phone's own
 * /24, forty probes at a time. Results are reported as they land so the list
 * fills in while the scan is still running.
 */

export type Discovered = {
  desktopId: string;
  /** The address that answered. */
  host: string;
  port: number;
  /** The machine name the desktop calls itself. */
  desktopHost: string;
  version: string;
  readOnly: boolean;
};

export type DiscoveryOptions = {
  onFound: (desktop: Discovered) => void;
  onProgress?: (label: string) => void;
  signal?: AbortSignal;
};

/** Seeds get a generous timeout; a subnet sweep cannot afford one. */
const SEED_TIMEOUT_MS = 1500;
const SUBNET_TIMEOUT_MS = 700;
const SUBNET_CONCURRENCY = 40;

async function probe(endpoint: Endpoint, timeoutMs: number, signal?: AbortSignal): Promise<Discovered | null> {
  try {
    const answer = await discover(endpoint, { timeoutMs, signal });
    if (answer.app !== 'lina-terminal') return null;
    return {
      desktopId: answer.desktopId || `${endpoint.host}:${endpoint.port}`,
      host: endpoint.host,
      port: endpoint.port,
      desktopHost: answer.host || endpoint.host,
      version: answer.version || '',
      readOnly: answer.readOnly === true,
    };
  } catch {
    return null;
  }
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      if (signal?.aborted) return;
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** The Metro host, when the app is running from a development server. */
export function developmentHostUri(): string | null {
  const config = Constants.expoConfig as { hostUri?: string } | null | undefined;
  return config?.hostUri || null;
}

async function ownIpAddress(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  try {
    const address = await Network.getIpAddressAsync();
    return address || null;
  } catch {
    return null;
  }
}

export async function discoverDesktops(options: DiscoveryOptions): Promise<Discovered[]> {
  const { onFound, onProgress, signal } = options;
  const found: Discovered[] = [];
  const seenDesktops = new Set<string>();

  const accept = (desktop: Discovered | null) => {
    if (!desktop || signal?.aborted) return;
    if (seenDesktops.has(desktop.desktopId)) return;
    seenDesktops.add(desktop.desktopId);
    found.push(desktop);
    onFound(desktop);
  };

  const seeds = seedCandidates({ hostUri: developmentHostUri(), platform: Platform.OS });
  onProgress?.('Looking for desktops…');
  await runPool(seeds, seeds.length, async endpoint => {
    accept(await probe(endpoint, SEED_TIMEOUT_MS, signal));
  }, signal);

  if (signal?.aborted) return found;

  // A browser cannot scan a subnet, and does not need to: the desktop it is
  // being developed against is on this machine.
  if (Platform.OS === 'web') {
    onProgress?.('');
    return found;
  }

  const ip = await ownIpAddress();
  const sweep = subnetCandidates(ip);
  if (sweep.length === 0) {
    onProgress?.('');
    return found;
  }

  onProgress?.(`Scanning ${subnetLabel(ip)}…`);
  await runPool(sweep, SUBNET_CONCURRENCY, async endpoint => {
    accept(await probe(endpoint, SUBNET_TIMEOUT_MS, signal));
  }, signal);

  onProgress?.('');
  return found;
}

/** What this phone calls itself when it asks a desktop for approval. */
export function describeThisDevice(deviceName: string | null, modelName: string | null) {
  return {
    deviceName: (deviceName || modelName || 'Phone').trim() || 'Phone',
    platform: Platform.OS,
  };
}
