import { Router } from "express";
import { healthRouter } from "./healthRoutes.js";
import { releaseRouter } from "./releaseRoutes.js";
import { statsRouter } from "./statsRoutes.js";
import { waitlistRouter } from "./waitlistRoutes.js";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(releaseRouter);
apiRouter.use(statsRouter);
apiRouter.use(waitlistRouter);
