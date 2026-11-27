#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (command === "setup") {
  const script = fileURLToPath(new URL("../windows/setup.py", import.meta.url));
  const python = process.env.HEADUNIT_PYTHON || "py";
  const result = spawnSync(python, [...(process.env.HEADUNIT_PYTHON ? [] : ["-3"]), script, ...args], {
    stdio: "inherit",
  });
  if (result.error) console.error("Install Python 3.12 with the Windows Python launcher, or set HEADUNIT_PYTHON.");
  process.exitCode = result.status ?? 1;
} else {
  console.log("Usage: agent-headunit setup [--phone-avd AA_Phone] [--receiver-avd AA_Receiver]");
  process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
}
