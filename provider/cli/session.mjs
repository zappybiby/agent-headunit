#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { backendFile } from "../runtime/backend-file.mjs";

const python = process.env.HEADUNIT_PYTHON || (process.platform === "win32" ? "python" : "python3");
const session = backendFile("open_headunit_session.py");
const result = spawnSync(python, ["-B", session, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
