import "dotenv/config";
import path from "node:path";

const numberFromEnv = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const env = {
  port: numberFromEnv(process.env.PORT, 3001),
  nodeEnv: process.env.NODE_ENV ?? "development",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5174",
  githubOwner: process.env.GITHUB_OWNER ?? "luigicarter",
  githubRepo: process.env.GITHUB_REPO ?? "VibeTerminal",
  waitlistFilePath:
    process.env.WAITLIST_FILE_PATH ?? path.resolve(process.cwd(), "data", "waitlist.json")
};
