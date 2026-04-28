import { randomUUID } from "node:crypto";
import { db } from "../db/db.js";

/**
 * Input contract for trace emission. Call sites pass created_at for API stability;
 * the persisted record always uses Date.now() at write time (unix ms).
 */
export type WriteTraceEventInput = {
  run_id: string;
  run_company_id: string | null;
  event_type: string;
  message: string;
  payload_json: string | null;
  created_at: number;
};

const insertTraceEvent = db.prepare(`
  INSERT INTO trace_events (id, run_id, run_company_id, event_type, message, payload_json, created_at)
  VALUES (@id, @run_id, @run_company_id, @event_type, @message, @payload_json, @created_at)
`);

/**
 * Sole trace write path: persists one row per event (roadmap 5.2).
 */
export function writeTraceEvent(event: WriteTraceEventInput): void {
  const id = randomUUID();
  const created_at = Date.now();
  insertTraceEvent.run({
    id,
    run_id: event.run_id,
    run_company_id: event.run_company_id,
    event_type: event.event_type,
    message: event.message,
    payload_json: event.payload_json,
    created_at,
  });
}
