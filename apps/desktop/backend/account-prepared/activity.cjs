'use strict';
// No timer or queue on import. The host opts in separately to presence and usage.
function createAccountActivity({
  transport,
  getDeviceId,
  isAllowed,
  presenceEnabled = false,
  usageEnabled = false,
}) {
  const object = (value, keys) =>
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every((key) => keys.includes(key));
  const valid = (event) =>
    object(event, [
      'eventId',
      'schemaVersion',
      'event',
      'occurredAt',
      'properties',
    ]) &&
    /^[0-9a-f-]{36}$/i.test(event.eventId || '') &&
    event.schemaVersion === 1 &&
    [
      'terminal.started',
      'agent.started',
      'orchestrator.started',
      'orchestrator.completed',
      'orchestrator.failed',
    ].includes(event.event) &&
    typeof event.occurredAt === 'string' &&
    event.occurredAt.length < 40 &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    object(event.properties, ['agent', 'durationMs', 'outcome']) &&
    (event.properties.agent === undefined ||
      [
        'codex',
        'claude',
        'gemini',
        'opencode',
        'fusion',
        'openfusion',
        'other',
      ].includes(event.properties.agent)) &&
    (event.properties.durationMs === undefined ||
      (Number.isInteger(event.properties.durationMs) &&
        event.properties.durationMs >= 0 &&
        event.properties.durationMs <= 86400000)) &&
    (event.properties.outcome === undefined ||
      ['completed', 'failed', 'canceled'].includes(event.properties.outcome));
  return {
    setUsage(value) {
      usageEnabled = value === true;
    },
    async heartbeat() {
      if (!presenceEnabled || !isAllowed()) return false;
      try {
        await transport.request('POST', '/api/v1/activity/heartbeat', {
          deviceId: getDeviceId(),
        });
        return true;
      } catch {
        return false;
      }
    },
    async events(events) {
      if (
        !usageEnabled ||
        !isAllowed() ||
        !Array.isArray(events) ||
        !events.length ||
        events.length > 50 ||
        !events.every(valid)
      )
        return false;
      const value = { deviceId: getDeviceId(), events };
      if (Buffer.byteLength(JSON.stringify(value)) > 32768) return false;
      try {
        await transport.request('POST', '/api/v1/activity/events', value);
        return true;
      } catch {
        return false;
      }
    },
  };
}
module.exports = { createAccountActivity };
