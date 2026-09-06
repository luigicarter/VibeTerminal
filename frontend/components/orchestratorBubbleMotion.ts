export interface BubbleMotion {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  frozen: boolean;
  impact: number;
  impactAngle: number;
  previousRadius: number;
}

export function createBubbleMotion(id: string, x: number, y: number, radius: number, previous?: BubbleMotion): BubbleMotion {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = (hash ^ (hash >>> 13)) >>> 0;
  const angle = (hash % 6283) / 1000;
  const speed = 18 + (hash % 1201) / 100;
  return { id, x, y, radius, vx: previous?.vx ?? Math.cos(angle) * speed,
    vy: previous?.vy ?? Math.sin(angle) * speed, frozen: false, impact: 0, impactAngle: 0, previousRadius: radius };
}

/** Mutates logical coordinates only; callers paint transforms without React updates. */
export function stepBubbleMotion(bodies: BubbleMotion[], width: number, height: number, elapsed: number): void {
  const dt = Math.max(0, Math.min(0.05, Number.isFinite(elapsed) ? elapsed : 0));
  const impact = (body: BubbleMotion, speed: number, angle: number) => {
    if (body.frozen || speed < 1) return;
    body.impact = Math.max(body.impact, Math.min(0.06, 0.025 + speed * 0.0008));
    body.impactAngle = angle;
  };
  const wall = (body: BubbleMotion) => {
    if (body.frozen && body.radius <= body.previousRadius) return;
    const minX = Math.min(body.radius + 18, width / 2), minY = Math.min(body.radius + 18, height / 2);
    if (body.x < minX) { if (body.x < body.previousRadius + 18) impact(body, -body.vx, 0); body.x = minX; body.vx = Math.abs(body.vx); }
    if (body.x > width - minX) { if (body.x > width - body.previousRadius - 18) impact(body, body.vx, 0); body.x = width - minX; body.vx = -Math.abs(body.vx); }
    if (body.y < minY) { if (body.y < body.previousRadius + 18) impact(body, -body.vy, Math.PI / 2); body.y = minY; body.vy = Math.abs(body.vy); }
    if (body.y > height - minY) { if (body.y > height - body.previousRadius - 18) impact(body, body.vy, Math.PI / 2); body.y = height - minY; body.vy = -Math.abs(body.vy); }
  };
  for (const body of bodies) {
    body.impact = body.frozen ? 0 : body.impact * Math.exp(-8 * dt);
    if (body.impact < 0.0001) body.impact = 0;
    if (!body.frozen) { body.x += body.vx * dt; body.y += body.vy * dt; }
    wall(body);
  }
  // Several small constraint passes handle contacts near walls and other bubbles.
  for (let pass = 0; pass < 8; pass++) {
    let contacts = false;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (a.frozen && b.frozen && a.radius <= a.previousRadius && b.radius <= b.previousRadius) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.hypot(dx, dy), minimum = a.radius + b.radius;
      if (distance >= minimum) continue;
      contacts = true;
      const nx = distance ? dx / distance : 1, ny = distance ? dy / distance : 0;
      const shareA = a.frozen && b.frozen ? 0.5 : a.frozen ? 0 : b.frozen ? 1 : 0.5;
      const shareB = 1 - shareA;
      const correction = minimum - distance + 0.001;
      a.x -= nx * correction * shareA; a.y -= ny * correction * shareA;
      b.x += nx * correction * shareB; b.y += ny * correction * shareB;
      const approach = ((b.frozen ? 0 : b.vx) - (a.frozen ? 0 : a.vx)) * nx
        + ((b.frozen ? 0 : b.vy) - (a.frozen ? 0 : a.vy)) * ny;
      if (approach < 0) {
        // Expanding into nearby space is geometry repair, not an impact.
        if (distance < a.previousRadius + b.previousRadius) {
          impact(a, -approach, Math.atan2(ny, nx));
          impact(b, -approach, Math.atan2(ny, nx));
        }
        a.vx += 2 * approach * nx * shareA; a.vy += 2 * approach * ny * shareA;
        b.vx -= 2 * approach * nx * shareB; b.vy -= 2 * approach * ny * shareB;
      }
    }
    for (const body of bodies) wall(body);
    if (!contacts) break;
  }
  for (const body of bodies) body.previousRadius = body.radius;
}
