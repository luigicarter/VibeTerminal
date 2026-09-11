import type { ErrorRequestHandler } from "express";
import { env } from "../config/env.js";
import type { ApiError } from "../types/errors.js";

export const errorHandler: ErrorRequestHandler = (error: ApiError, _request, response, _next) => {
  const statusCode = error.statusCode ?? 500;

  response.status(statusCode).json({
    error: {
      message: statusCode === 500 ? "Unexpected server error" : error.message,
      ...(env.nodeEnv === "development" && error.details ? { details: error.details } : {})
    }
  });
};
