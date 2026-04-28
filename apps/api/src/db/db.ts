import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSchema } from "./schema.js";

/** Directory containing this package's package.json (stable regardless of cwd). */
const apiPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveDbPath(): string {
  const fromEnv = process.env.DB_PATH?.trim();
  if (fromEnv) {
    // Resolve relative paths against the package root, not process.cwd().
    return isAbsolute(fromEnv) ? fromEnv : join(apiPackageRoot, fromEnv);
  }
  return join(apiPackageRoot, "data", "surveyor.sqlite");
}

const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

/** Single shared SQLite connection for the API process. */
export const db: InstanceType<typeof Database> = new Database(dbPath);
ensureSchema(db);
