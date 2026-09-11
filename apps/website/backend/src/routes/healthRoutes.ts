import { Router } from "express";
import { healthController } from "../controllers/healthController.js";

export const healthRouter = Router();

healthRouter.get("/health", healthController);
