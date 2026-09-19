/**
 * Minimal .env loader — no dependencies.
 * Supports KEY=VALUE, optional single/double quotes, # comments.
 * Does not override existing process.env values.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnv(fromDir = path.dirname(fileURLToPath(import.meta.url))) {
  const envPath = path.join(fromDir, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Missing .env at ${envPath}\nCopy .env.example → .env and fill in your values.`
    );
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
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
    } else {
      const hash = val.search(/\s+#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function requireEnv(key) {
  const v = process.env[key];
  if (v == null || !String(v).trim()) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return String(v).trim();
}

export function envInt(key, fallback) {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
