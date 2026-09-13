'use strict';

/**
 * Read-only desktops, in one place.
 *
 * Some desktop builds serve the bridge for reading only: `/api/hello` reports
 * `readOnly: true`, and the write routes answer 404 `{ok:false,error:'not
 * found'}`. A desktop that serves the route but has not granted control to this
 * phone answers 403 `{ok:false,error:'control not allowed'}` instead. The flag
 * is not enough on its own — an older or newer desktop may omit it — so a 403
 * or a 404 from a write route is treated as the same answer.
 *
 * Plain CommonJS so both the app (through Metro) and `node --test` can use the
 * exact same function.
 */

/** The note shown in place of a composer when the desktop will not take input. */
const READ_ONLY_NOTE =
  'This desktop build only shows your terminals. Typing from the phone is not enabled yet.';

/** The routes that send something to the desktop. */
const WRITE_ROUTES = ['input', 'keys', 'interrupt', 'orchestrator-request'];

/**
 * Does this failure mean "this desktop does not accept input"?
 * Only a 403 or a 404 from a write route counts: a 404 from a read route means
 * the terminal is gone, and a 409 means the terminal exited.
 *
 * @param {unknown} error a BridgeError from the client
 * @param {string} route one of WRITE_ROUTES
 * @returns {boolean}
 */
function isReadOnlyRejection(error, route) {
  if (!WRITE_ROUTES.includes(route)) return false;
  if (!error || typeof error !== 'object') return false;
  const candidate = /** @type {{status?: number, kind?: string, bridgeError?: boolean}} */ (error);
  if (candidate.status === 403 || candidate.status === 404) return true;
  return candidate.bridgeError === true && (candidate.kind === 'notFound' || candidate.kind === 'forbidden');
}

module.exports = { READ_ONLY_NOTE, WRITE_ROUTES, isReadOnlyRejection };
