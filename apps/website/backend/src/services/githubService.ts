import { githubConfig } from "../config/github.js";
import type { LatestReleaseResponse, RepoStatsResponse } from "../types/api.js";
import type { GitHubRelease, GitHubRepo } from "../types/github.js";
import { createHttpError } from "../utils/httpError.js";

const githubRequest = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${githubConfig.apiBaseUrl}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": githubConfig.userAgent,
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });

  if (!response.ok) {
    const details = await response.text();
    throw createHttpError(response.status, "GitHub request failed", details);
  }

  return (await response.json()) as T;
};

export const getLatestRelease = async (): Promise<LatestReleaseResponse> => {
  const release = await githubRequest<GitHubRelease>(
    `/repos/${githubConfig.owner}/${githubConfig.repo}/releases/latest`
  );

  return {
    tagName: release.tag_name,
    name: release.name ?? release.tag_name,
    body: release.body,
    htmlUrl: release.html_url,
    publishedAt: release.published_at,
    assets: release.assets.map((asset) => ({
      name: asset.name,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
      contentType: asset.content_type
    }))
  };
};

export const getRepoStats = async (): Promise<RepoStatsResponse> => {
  const repo = await githubRequest<GitHubRepo>(`/repos/${githubConfig.owner}/${githubConfig.repo}`);

  return {
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.watchers_count,
    openIssues: repo.open_issues_count,
    defaultBranch: repo.default_branch,
    pushedAt: repo.pushed_at,
    htmlUrl: repo.html_url
  };
};
