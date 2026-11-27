#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import manifest from "../package.json" with { type: "json" };

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

function findPython() {
  const paths = new Set();
  if (process.env.HEADUNIT_PYTHON) {
    paths.add(process.env.HEADUNIT_PYTHON);
  } else {
    for (const line of output("py", ["-0p"]).split(/\r?\n/)) {
      const match = line.match(/(?:^|\s)((?:[A-Za-z]:\\|\\\\).+?\.exe)\s*$/i);
      if (match) paths.add(match[1]);
    }
    for (const path of output("where.exe", ["python.exe"]).split(/\r?\n/)) {
      if (path && !/\\Microsoft\\WindowsApps\\python\.exe$/i.test(path)) paths.add(path);
    }
  }
  const probe = "import struct, sys; print('%s.%s' % sys.version_info[:2] if struct.calcsize('P') == 8 and sys.version_info.releaselevel == 'final' else '')";
  for (const path of paths) {
    if (manifest.windowsPython.includes(output(path, ["-I", "-c", probe]))) return path;
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "setup") {
  const python = findPython();
  if (python) {
    const packaged = fileURLToPath(new URL("../windows/setup.py", import.meta.url));
    const script = existsSync(packaged) ? packaged : fileURLToPath(new URL("../../windows/setup.py", import.meta.url));
    const result = spawnSync(python, ["-B", script, ...args], { stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  } else {
    console.error(`Setup requires 64-bit Python ${manifest.windowsPython.join(", ")}. Install a supported interpreter or set HEADUNIT_PYTHON to its executable.`);
    process.exitCode = 1;
  }
} else {
  console.log("Usage: agent-headunit setup [--list-avds] [--phone-avd NAME] [--receiver-avd NAME] [--install-receiver | --receiver-apk FILE]");
  process.exitCode = command === "--help" || command === "-h" ? 0 : 1;
}
