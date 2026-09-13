'use strict';

/**
 * Pure presence mapping: what the connection dot and the Orchestrator subtitle
 * are allowed to claim.
 *
 * Both rules exist because the honest answer before the first poll is "not yet
 * known", which is not the same as "failed" or "off". Plain CommonJS so the app
 * (through Metro) and `node --test` use the same function.
 */

/** A successful poll counts as "connected" for this long. */
const FRESH_WINDOW_MS = 30000;

const TONE_LABELS = {
  connected: 'connected',
  reconnecting: 'reconnecting',
  failed: 'not connected',
  connecting: 'connecting…',
  paused: 'paused',
};

/**
 * @param {string} status one of idle|connecting|online|reconnecting|offline
 * @param {number|null} lastSuccessAt epoch ms of the last successful poll
 * @param {{ now?: number, appActive?: boolean }} [options]
 * @returns {'connected'|'reconnecting'|'failed'|'connecting'|'paused'}
 */
function connectionTone(status, lastSuccessAt, options) {
  const now = options && typeof options.now === 'number' ? options.now : Date.now();
  const appActive = !options || options.appActive === undefined ? true : options.appActive !== false;

  // The loop is stopped on purpose while the app is in the background.
  if (!appActive) return 'paused';
  if (status === 'offline') return 'failed';
  if (status === 'online') {
    if (typeof lastSuccessAt === 'number' && now - lastSuccessAt <= FRESH_WINDOW_MS) return 'connected';
    return 'reconnecting';
  }
  if (status === 'reconnecting') return 'reconnecting';
  // 'idle' and 'connecting': nothing has failed yet, so claim nothing.
  return 'connecting';
}

/**
 * @param {{ enabled?: boolean, ready?: boolean } | null | undefined} orchestrator
 * @returns {string} the text after "Orchestrator · ", or '' when unknown
 */
function orchestratorStateLabel(orchestrator) {
  if (!orchestrator) return '';
  if (orchestrator.enabled === false) return 'off';
  if (orchestrator.ready === true) return 'ready';
  return 'starting…';
}

/** "Orchestrator", "Orchestrator · ready", "Orchestrator · off". */
function orchestratorSubtitle(orchestrator) {
  const state = orchestratorStateLabel(orchestrator);
  return state ? `Orchestrator · ${state}` : 'Orchestrator';
}

module.exports = {
  FRESH_WINDOW_MS,
  TONE_LABELS,
  connectionTone,
  orchestratorStateLabel,
  orchestratorSubtitle,
};
