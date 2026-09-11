import type { RequestHandler } from "express";
import { getHealth } from "../services/healthService.js";

export const healthController: RequestHandler = (_request, response) => {
  response.json(getHealth());
};
