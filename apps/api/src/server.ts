import express from "express";
import 'dotenv/config';
import { runRestartRecovery } from "./worker/restartRecovery.js";
import { startWorkerLoop } from "./worker/startWorkerLoop.js";
import { runsRouter } from "./routes/runs.js";
import { jobDetailsRouter } from "./routes/jobDetails.js";

const app = express();
const PORT = Number(process.env.PORT ?? "3000");

app.use(express.json());
app.use(runsRouter);
app.use(jobDetailsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Export app for endpoint tests. listen() is guarded so importing this module
// in test files does not start the worker loop or bind a port.
export { app };

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    runRestartRecovery();
    startWorkerLoop();
  });
}
