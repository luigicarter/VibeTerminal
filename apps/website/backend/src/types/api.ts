export type HealthResponse = {
  status: "ok";
  service: string;
  timestamp: string;
  uptimeSeconds: number;
};

export type ReleaseAsset = {
  name: string;
  downloadUrl: string;
  size: number;
  contentType: string;
};

export type LatestReleaseResponse = {
  tagName: string;
  name: string;
  body: string | null;
  htmlUrl: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
};

export type RepoStatsResponse = {
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
};

export type WaitlistRequest = {
  email: string;
  source?: string;
};

export type WaitlistResponse = {
  email: string;
  status: "joined" | "already_joined";
  submittedAt: string;
};
