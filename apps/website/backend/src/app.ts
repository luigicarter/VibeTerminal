import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFoundHandler } from "./middleware/notFoundHandler.js";
import { apiRouter } from "./routes/index.js";

export const createApp = () => {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigin,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"]
    })
  );
  app.use(express.json({ limit: "32kb" }));

  app.use("/api", apiRouter);
  const frontendDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/dist");
  app.use(express.static(frontendDist));
  app.get(["/", "/fusion", "/open-fusion", "/orchestrator", "/agents", "/voice", "/pricing"], (_request, response) => {
    response.sendFile(path.join(frontendDist, "index.html"));
  });
  app.get(/^\/docs(?:\/.*)?$/, (_request, response) => {
    response.sendFile(path.join(frontendDist, "index.html"));
  });
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
