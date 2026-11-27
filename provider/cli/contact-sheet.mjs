#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { backendFile } from "../runtime/backend-file.mjs";

const script = backendFile("contact_sheet.py");
const run = promisify(execFile);

export async function contactSheet({ video, out, cwd, env, python }) {
  const executable = python || env.HEADUNIT_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const args = ["-B", script, video, ...(out ? ["--out", out] : []), "--json"];
  let stdout;
  try {
    ({ stdout } = await run(executable, args, { cwd, env, maxBuffer: 1024 * 1024, timeout: 120000 }));
  } catch (error) {
    if (typeof error.stdout !== "string" || !error.stdout.trim()) {
      return { success: false, error: { code: "COMMAND_FAILED", message: `Contact sheet helper failed: ${error.message}` } };
    }
    stdout = error.stdout;
  }
  try { return JSON.parse(stdout); }
  catch { return { success: false, error: { code: "COMMAND_FAILED", message: "Contact sheet helper returned invalid JSON." } }; }
}

let invokedPath;
try { if (process.argv[1]) invokedPath = realpathSync(process.argv[1]); } catch {}
if (invokedPath === fileURLToPath(import.meta.url)) {
  const python = process.env.HEADUNIT_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, ["-B", script, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
