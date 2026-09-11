import { useEffect, useState } from "react";
import { apiClient } from "../services/apiClient";
import type { LatestRelease, Loadable } from "../types/api";

export const useLatestRelease = (enabled = true): Loadable<LatestRelease> => {
  const [state, setState] = useState<Loadable<LatestRelease>>({
    data: null,
    error: null,
    status: "idle"
  });

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;

    setState((current) => ({ ...current, status: "loading" }));

    apiClient
      .getLatestRelease()
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
  }, [enabled]);

  return state;
};
