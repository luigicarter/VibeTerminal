export type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
  content_type: string;
};

export type GitHubRelease = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  assets: GitHubReleaseAsset[];
};

export type GitHubRepo = {
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  default_branch: string;
  pushed_at: string | null;
  html_url: string;
};
