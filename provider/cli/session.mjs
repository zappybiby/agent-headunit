#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = process.env.HEADUNIT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const session = fileURLToPath(new URL("../backend/open_headunit_session.py", import.meta.url));
const result = spawnSync(python, ["-B", session, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
