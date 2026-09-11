import type { RequestHandler } from "express";
import { captureWaitlistEmail } from "../services/waitlistService.js";
import type { WaitlistRequest } from "../types/api.js";

export const waitlistController: RequestHandler = async (request, response) => {
  const body = request.body as Partial<WaitlistRequest>;
  const result = await captureWaitlistEmail(body.email ?? "", body.source);
  response.status(result.status === "joined" ? 201 : 200).json(result);
};
