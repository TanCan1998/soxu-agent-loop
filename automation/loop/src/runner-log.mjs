import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable runner log: the dashboard may be restarted (hot update) while a runner
 * is still working, so the log must not live only in the dashboard process.
 */
export function teeStdioToFile(path) {
  if (typeof path !== "string" || !path) throw new Error("Invalid runner log path");
  mkdirSync(dirname(path), { recursive: true });
  const write = (stream) => {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      try { appendFileSync(path, typeof chunk === "string" ? chunk : Buffer.from(chunk), "utf8"); }
      catch { /* Logging must never break a run. */ }
      return original(chunk, encoding, callback);
    };
  };
  write(process.stdout);
  write(process.stderr);
}
