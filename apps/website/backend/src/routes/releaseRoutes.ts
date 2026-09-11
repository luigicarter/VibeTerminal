import { Router } from "express";
import { latestReleaseController } from "../controllers/releaseController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const releaseRouter = Router();

releaseRouter.get("/release/latest", asyncHandler(latestReleaseController));
