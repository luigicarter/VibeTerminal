'use strict';
const { createPublicKey, verify } = require('node:crypto');
const safe = new Set(['view', 'copy', 'export', 'stop', 'resize']);
const features = {
  'terminal.launch': 'terminals',
  'terminal.input': 'terminals',
  'agent.launch': 'agent_modes',
  'agent.input': 'agent_modes',
  'fusion.launch': 'fusion',
  'fusion.input': 'fusion',
  'openfusion.launch': 'open_fusion',
  'openfusion.input': 'open_fusion',
  'orchestrator.start': 'orchestrator',
  'orchestrator.input': 'orchestrator',
  'voice.start': 'voice',
  'workspace.mutate': 'workspace',
  'git.mutate': 'git',
  'provider.mutate': 'provider_settings',
};
function createAccessPolicy({
  issuer,
  publicKeys,
  now = Date.now,
  monotonic = () => performance.now(),
}) {
  const keys = Object.fromEntries(
    Object.entries(publicKeys).map(([id, key]) => {
      const parsed = createPublicKey(key);
      if (parsed.asymmetricKeyType !== 'ed25519')
        throw Error('invalid_verification_key');
      return [id, parsed];
    }),
  );
  let lease = null,
    identity = null,
    lastWall = now(),
    lastMono = monotonic(),
    epoch = 0,
    reason = 'login_required',
    highWater = lastWall;
  function clock() {
    const wall = now(),
      mono = monotonic();
    if (wall < highWater - 1000 || wall < lastWall + (mono - lastMono) - 5000) {
      clear('clock_changed');
      throw Error('clock_changed');
    }
    highWater = Math.max(highWater, wall);
    lastWall = wall;
    lastMono = mono;
    return wall;
  }
  function clear(code = 'access_denied') {
    lease = null;
    identity = null;
    reason = code;
    epoch++;
  }
  function accept(token, owner, observedTime = 0) {
    const previous = lease,
      previousEpoch = epoch;
    clear('entitlement_invalid');
    if (typeof token !== 'string' || token.length > 16384) throw Error(reason);
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
    )
      throw Error(reason);
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch {
      throw Error(reason);
    }
    if (
      header.alg !== 'EdDSA' ||
      header.typ !== 'JWT' ||
      typeof header.kid !== 'string' ||
      !Object.hasOwn(keys, header.kid) ||
      header.jwk ||
      header.jku ||
      header.crit ||
      !verify(
        null,
        Buffer.from(parts[0] + '.' + parts[1]),
        keys[header.kid],
        Buffer.from(parts[2], 'base64url'),
      )
    )
      throw Error(reason);
    highWater = Math.max(highWater, observedTime);
    const current = clock() / 1000;
    const allowed = [
      'workspace',
      'terminals',
      'agent_modes',
      'fusion',
      'open_fusion',
      'git',
      'provider_settings',
      ...(claims.tier === 'orchestrator'
        ? ['orchestrator', 'voice', 'orchestrator_history']
        : []),
    ];
    if (
      claims.iss !== issuer ||
      claims.aud !== 'lina-desktop' ||
      claims.sub !== owner.userId ||
      claims.sid !== owner.sessionId ||
      claims.device !== owner.deviceId ||
      !['full_access', 'orchestrator'].includes(claims.tier) ||
      !Number.isInteger(claims.iat) ||
      !Number.isInteger(claims.exp) ||
      claims.iat > current + 30 ||
      claims.exp <= current ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 86400 ||
      !Number.isInteger(claims.revision) ||
      claims.revision < 0 ||
      !Array.isArray(claims.features) ||
      claims.features.some((f) => !allowed.includes(f))
    )
      throw Error(reason);
    lease = claims;
    identity = {
      userId: owner.userId,
      sessionId: owner.sessionId,
      deviceId: owner.deviceId,
    };
    reason = null;
    if (
      previous &&
      previous.sub === claims.sub &&
      previous.sid === claims.sid &&
      previous.revision === claims.revision &&
      JSON.stringify(previous.features) === JSON.stringify(claims.features)
    )
      epoch = previousEpoch;
    return snapshot();
  }
  function assert(action) {
    if (safe.has(action)) return;
    if (!Object.hasOwn(features, action)) throw Error('operation_not_allowed');
    const current = clock() / 1000;
    if (!lease || lease.exp <= current) {
      clear(lease ? 'access_expired' : reason);
      throw Error(reason);
    }
    if (!lease.features.includes(features[action]))
      throw Error('feature_not_in_plan');
  }
  function snapshot() {
    try {
      if (lease && lease.exp <= clock() / 1000) clear('access_expired');
    } catch {}
    return {
      allowed: !!lease,
      reason,
      tier: lease?.tier || null,
      expiresAt: lease ? new Date(lease.exp * 1000).toISOString() : null,
      highWater,
      identity,
    };
  }
  function schedule(action, work) {
    assert(action);
    const admission = epoch;
    return async (...args) => {
      if (admission !== epoch) throw Error('queued_access_changed');
      assert(action);
      return work(...args);
    };
  }
  return { accept, clear, assert, snapshot, schedule };
}
module.exports = { createAccessPolicy };
