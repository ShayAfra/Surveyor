import express from "express";
import 'dotenv/config';
import { runRestartRecovery } from "./worker/restartRecovery.js";
import { startWorkerLoop } from "./worker/startWorkerLoop.js";
import { startMonitoringLoop } from "./monitoring/startMonitoringLoop.js";
import { runsRouter } from "./routes/runs.js";
import { jobDetailsRouter } from "./routes/jobDetails.js";
import { authRouter } from "./routes/auth.js";
import { profileRouter } from "./routes/profile.js";
import { fitAnalysisRouter } from "./routes/fitAnalysis.js";
import { applicationPacketRouter } from "./routes/applicationPacket.js";
import { savedCompaniesRouter } from "./routes/savedCompanies.js";
import { savedSearchesRouter } from "./routes/savedSearches.js";
import { applicationsRouter } from "./routes/applications.js";

const app = express();
const PORT = Number(process.env.PORT ?? "3000");

app.use(express.json());
app.use(authRouter);
app.use(runsRouter);
app.use(jobDetailsRouter);
app.use(profileRouter);
app.use(fitAnalysisRouter);
app.use(applicationPacketRouter);
app.use(savedCompaniesRouter);
app.use(savedSearchesRouter);
app.use(applicationsRouter);

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
    startMonitoringLoop();
  });
}
