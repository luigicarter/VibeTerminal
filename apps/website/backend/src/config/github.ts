import { env } from "./env.js";

export const githubConfig = {
  apiBaseUrl: "https://api.github.com",
  owner: env.githubOwner,
  repo: env.githubRepo,
  userAgent: "vibeTerminal-website-api"
};
