import express from "express";
import { healthRouter } from "./routes/health";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use("/health", healthRouter);

app.get("/", (_req, res) => {
  res.json({ message: "Hello from dagger-k8s sample app" });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

export { app };
