import type { ApiError } from "../types/errors.js";

export const createHttpError = (statusCode: number, message: string, details?: unknown): ApiError => {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.details = details;
  return error;
};
