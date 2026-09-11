export type ApiStatus = "idle" | "loading" | "success" | "error";

export type ReleaseAsset = {
  name: string;
  downloadUrl: string;
  size: number;
  contentType: string;
};

export type LatestRelease = {
  tagName: string;
  name: string;
  body: string | null;
  htmlUrl: string;
  publishedAt: string | null;
  assets: ReleaseAsset[];
};

export type RepoStats = {
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  defaultBranch: string;
  pushedAt: string | null;
  htmlUrl: string;
};

export type WaitlistResponse = {
  email: string;
  status: "joined" | "already_joined";
  submittedAt: string;
};

export type Loadable<T> = {
  data: T | null;
  error: string | null;
  status: ApiStatus;
};
