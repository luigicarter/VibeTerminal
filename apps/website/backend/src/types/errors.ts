export type ApiError = Error & {
  statusCode?: number;
  details?: unknown;
};
