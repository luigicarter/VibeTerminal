import type { RequestHandler } from "express";
import { getRepoStats } from "../services/githubService.js";

export const statsController: RequestHandler = async (_request, response) => {
  response.json(await getRepoStats());
};
