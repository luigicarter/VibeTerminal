import type { LatestRelease, RepoStats, WaitlistResponse } from "../types/api";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

const request = async <T>(path: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(12000),
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    },
    ...options
  });

  if (!response.ok) {
    const fallbackMessage = `Request failed with status ${response.status}`;
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message ?? fallbackMessage);
  }

  return (await response.json()) as T;
};

export const apiClient = {
  getLatestRelease: () => request<LatestRelease>("/release/latest"),
  getRepoStats: () => request<RepoStats>("/stats"),
  joinWaitlist: (email: string) =>
    request<WaitlistResponse>("/waitlist", {
      method: "POST",
      body: JSON.stringify({ email, source: "marketing_site" })
    })
};
