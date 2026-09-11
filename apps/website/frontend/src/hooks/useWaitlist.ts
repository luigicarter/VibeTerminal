import { useState } from "react";
import { apiClient } from "../services/apiClient";
import type { WaitlistResponse } from "../types/api";

type WaitlistState = {
  data: WaitlistResponse | null;
  error: string | null;
  status: "idle" | "loading" | "success" | "error";
};

export const useWaitlist = () => {
  const [state, setState] = useState<WaitlistState>({
    data: null,
    error: null,
    status: "idle"
  });

  const submit = async (email: string) => {
    setState({ data: null, error: null, status: "loading" });

    try {
      const data = await apiClient.joinWaitlist(email);
      setState({ data, error: null, status: "success" });
    } catch (error) {
      setState({
        data: null,
        error: error instanceof Error && !["TypeError", "TimeoutError", "AbortError"].includes(error.name) ? error.message : "We couldn't save your email. Please try again in a moment.",
        status: "error"
      });
    }
  };

  return {
    ...state,
    submit
  };
};
