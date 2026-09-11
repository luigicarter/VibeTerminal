import type { RequestHandler } from "express";
import { getLatestRelease } from "../services/githubService.js";

export const latestReleaseController: RequestHandler = async (_request, response) => {
  response.json(await getLatestRelease());
};
