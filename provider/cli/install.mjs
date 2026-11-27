#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = process.env.HEADUNIT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const installer = fileURLToPath(new URL("../install_provider.py", import.meta.url));
const result = spawnSync(python, ["-B", installer, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error?.code === "ENOENT" || result.error?.code === "EACCES") {
  console.error(`Could not run Python at ${JSON.stringify(python)}. Install Python or set HEADUNIT_PYTHON to a runnable interpreter.`);
} else if (result.error) {
  console.error(result.error.message);
}
process.exitCode = result.status ?? 1;
