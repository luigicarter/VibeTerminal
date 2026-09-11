import type { LucideIcon } from "lucide-react";

export type Feature = {
  title: string;
  description: string;
  icon: LucideIcon;
};

export type WorkflowPanel = {
  agent: string;
  role: string;
  status: string;
  lines: string[];
};

export type Metric = {
  label: string;
  value: string;
};
