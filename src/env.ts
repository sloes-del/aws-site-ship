/**
 * Minimal .env loader (no dotenv dependency).
 * Loads cwd/.env then ~/.aws-site-ship/.env — does not override existing process.env.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function applyEnv(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = parseEnvFile(readFileSync(path, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return true;
  } catch {
    return false;
  }
}

let loaded = false;

/** Idempotent. Call once at CLI boot. */
export function loadEnv(): { loadedFrom: string[] } {
  if (loaded) return { loadedFrom: [] };
  loaded = true;
  const loadedFrom: string[] = [];
  const candidates = [
    join(process.cwd(), ".env"),
    join(homedir(), ".aws-site-ship", ".env"),
  ];
  for (const p of candidates) {
    if (applyEnv(p)) loadedFrom.push(p);
  }
  return { loadedFrom };
}
