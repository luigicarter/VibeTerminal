import { useEffect, useState } from "react";
import { apiClient } from "../services/apiClient";
import type { Loadable, RepoStats } from "../types/api";

export const useRepoStats = (): Loadable<RepoStats> => {
  const [state, setState] = useState<Loadable<RepoStats>>({
    data: null,
    error: null,
    status: "idle"
  });

  useEffect(() => {
    let mounted = true;

    setState((current) => ({ ...current, status: "loading" }));

    apiClient
      .getRepoStats()
      .then((data) => {
        if (mounted) {
          setState({ data, error: null, status: "success" });
        }
      })
      .catch((error: Error) => {
        if (mounted) {
          setState({ data: null, error: error.message, status: "error" });
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return state;
};
