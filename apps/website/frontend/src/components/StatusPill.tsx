import type { ReactNode } from "react";

type StatusPillProps = {
  children: ReactNode;
  tone?: "green" | "cyan" | "amber" | "rose";
};

export const StatusPill = ({ children, tone = "green" }: StatusPillProps) => (
  <span className={`status-pill status-pill--${tone}`}>{children}</span>
);
