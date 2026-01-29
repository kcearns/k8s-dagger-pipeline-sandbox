import { Router } from "express";

export const healthRouter = Router();

const startTime = Date.now();

healthRouter.get("/", (_req, res) => {
  res.json({ status: "ok" });
});

healthRouter.get("/ready", (_req, res) => {
  res.json({
    status: "ready",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

healthRouter.get("/live", (_req, res) => {
  res.json({ status: "alive" });
});
