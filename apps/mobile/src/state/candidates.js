'use strict';

/**
 * Where to look for a desktop, as pure data.
 *
 * Discovery has to work in four different places — a phone on Wi-Fi, an Android
 * emulator, Expo Go pointed at a Metro host, and a browser on the development
 * machine — so the address list is built here, away from the network code, and
 * tested directly.
 */

/** The desktop bridge's port, and the mock's port one above it. */
const BRIDGE_PORTS = [47831, 47832];

/** The Android emulator reaches its host machine through this alias. */
const ANDROID_HOST_ALIAS = '10.0.2.2';

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

function isLoopback(host) {
  return LOOPBACK.includes(String(host || '').toLowerCase());
}

/** "192.168.1.20:8081" or "exp://192.168.1.20:8081" -> "192.168.1.20". */
function hostFromHostUri(hostUri) {
  const raw = String(hostUri || '').trim();
  if (!raw) return null;
  const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const host = withoutScheme.split('/')[0].split('?')[0].replace(/:\d+$/, '');
  return host || null;
}

function push(list, seen, host, port) {
  if (!host) return;
  const key = `${host}:${port}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ host, port });
}

/**
 * The addresses worth trying before any subnet scan.
 *
 * @param {{ hostUri?: string|null, platform?: string }} options
 * @returns {Array<{host: string, port: number}>}
 */
function seedCandidates(options) {
  const { hostUri = null, platform = 'ios' } = options || {};
  const devHost = hostFromHostUri(hostUri);
  const list = [];
  const seen = new Set();

  // The machine serving Metro is nearly always the machine running the desktop.
  if (devHost && !isLoopback(devHost)) {
    for (const port of BRIDGE_PORTS) push(list, seen, devHost, port);
  }

  // Inside an Android emulator, "localhost" is the emulator itself.
  if (platform === 'android' && (!devHost || isLoopback(devHost))) {
    for (const port of BRIDGE_PORTS) push(list, seen, ANDROID_HOST_ALIAS, port);
  }

  // The development machine, for the web build and for a desktop simulator.
  for (const port of BRIDGE_PORTS) push(list, seen, 'localhost', port);

  return list;
}

/**
 * Every address on this phone's /24, minus the phone itself.
 *
 * @param {string|null} ip the phone's own address
 * @param {number} [port]
 * @returns {Array<{host: string, port: number}>}
 */
function subnetCandidates(ip, port = BRIDGE_PORTS[0]) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!match) return [];
  const octets = match.slice(1).map(Number);
  if (octets.some(value => value > 255)) return [];
  if (isLoopback(ip) || octets[0] === 127) return [];
  const base = `${octets[0]}.${octets[1]}.${octets[2]}.`;
  const own = octets[3];
  const list = [];
  for (let last = 1; last <= 254; last += 1) {
    if (last === own) continue;
    list.push({ host: `${base}${last}`, port });
  }
  return list;
}

/** "192.168.2.x" — what the progress line shows while scanning. */
function subnetLabel(ip) {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(String(ip || '').trim());
  return match ? `${match[1]}.x` : '';
}

module.exports = {
  ANDROID_HOST_ALIAS,
  BRIDGE_PORTS,
  hostFromHostUri,
  isLoopback,
  seedCandidates,
  subnetCandidates,
  subnetLabel,
};
