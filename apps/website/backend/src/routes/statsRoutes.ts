import { Router } from "express";
import { statsController } from "../controllers/statsController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const statsRouter = Router();

statsRouter.get("/stats", asyncHandler(statsController));
