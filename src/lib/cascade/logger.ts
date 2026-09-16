import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RequestLogRow } from "./types";

/**
 * Request logger — one row per request, whichever path it took.
 *
 * Storage is append-only JSONL on local disk, which suits a low-volume
 * evaluation platform and keeps the project dependency-free. It assumes a
 * writable, persistent filesystem: on a serverless host (Vercel included) the
 * filesystem is ephemeral and per-instance, so deploying there means swapping
 * this module for a real datastore. The read/write interface below is the only
 * surface that would need to change.
 */

const LOG_DIR = path.join(process.cwd(), ".data");
const LOG_PATH = path.join(LOG_DIR, "requests.jsonl");

export async function logRequest(row: RequestLogRow): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_PATH, `${JSON.stringify(row)}\n`, "utf8");
  } catch (error) {
    // Losing a metrics row must never fail the user's request.
    console.error("[cascade] failed to write request log:", error);
  }
}

export async function readRequestLog(): Promise<RequestLogRow[]> {
  let contents: string;
  try {
    contents = await readFile(LOG_PATH, "utf8");
  } catch {
    return []; // No requests logged yet.
  }

  const rows: RequestLogRow[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as RequestLogRow);
    } catch {
      // Skip a torn final line rather than failing the whole dashboard.
      continue;
    }
  }

  return rows;
}
