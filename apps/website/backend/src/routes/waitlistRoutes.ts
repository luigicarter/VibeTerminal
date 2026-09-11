import { Router } from "express";
import { waitlistController } from "../controllers/waitlistController.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const waitlistRouter = Router();

waitlistRouter.post("/waitlist", asyncHandler(waitlistController));
