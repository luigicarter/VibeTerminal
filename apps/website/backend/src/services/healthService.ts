import type { HealthResponse } from "../types/api.js";

export const getHealth = (): HealthResponse => ({
  status: "ok",
  service: "vibeTerminal website API",
  timestamp: new Date().toISOString(),
  uptimeSeconds: Math.round(process.uptime())
});
