import type { LatestRelease } from "../types/api";

export const REPOSITORY_URL = "https://github.com/luigicarter/VibeTerminal";
export const RELEASES_URL = `${REPOSITORY_URL}/releases/latest`;

export const releaseLinks = (release: LatestRelease | null) => {
  const installer = release?.assets.find((asset) => /^(?:LinaTerminal|vibeTerminal)-Setup-.*\.exe$/i.test(asset.name));
  return { downloadUrl: installer?.downloadUrl ?? RELEASES_URL, hasInstaller: Boolean(installer), notesUrl: release?.htmlUrl ?? RELEASES_URL };
};
