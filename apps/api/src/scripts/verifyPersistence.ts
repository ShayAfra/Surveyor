import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureSchema } from "../db/schema.js";

const apiPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPath = process.env.DB_PATH?.trim() || join(apiPackageRoot, "data", "surveyor.sqlite");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // Server may still be starting up; retry until timeout.
    }
    await sleep(100);
  }

  throw new Error("Timed out waiting for server health endpoint");
}

async function startAndStopServer(): Promise<void> {
  const child = spawn("node", ["dist/server.js"], {
    cwd: apiPackageRoot,
    env: { ...process.env, PORT: "3100", DB_PATH: dbPath },
    stdio: "ignore",
  });

  try {
    await waitForHealth("http://127.0.0.1:3100", 5000);
  } finally {
    child.kill("SIGTERM");
  }
}

async function verifyPersistence(): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  ensureSchema(db);

  const runId = `persistence-test-${randomUUID()}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO runs (
      id, created_at, status, role_raw, include_adjacent, role_spec_json,
      role_spec_started_at, company_count, error_code, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(runId, now, "CREATED", "Persistence Test", 0, null, null, 0, null, null);

  db.close();

  await startAndStopServer();
  await startAndStopServer();

  const verifyDb = new Database(dbPath, { readonly: true });
  const row = verifyDb.prepare("SELECT id FROM runs WHERE id = ?").get(runId) as { id: string } | undefined;
  verifyDb.close();

  if (!row) {
    throw new Error("Persistence verification failed: inserted row not found after restart");
  }

  process.stdout.write(`Persistence verified for run id: ${runId}\n`);
}

void verifyPersistence();
