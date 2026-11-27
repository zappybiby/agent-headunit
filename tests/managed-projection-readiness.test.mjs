import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startManagedProjection } from "../provider/managed-projection.mjs";

test("managed startup reports Python and Frida prerequisites and reads the final stderr diagnostic", async (t) => {
  const temp = path.resolve(tmpdir());
  const base = await mkdtemp(path.join(temp, "headunit-readiness-"));
  t.after(async () => {
    assert.equal(path.dirname(base), temp);
    assert.match(path.basename(base), /^headunit-readiness-/);
    await rm(base, { recursive: true, force: true });
  });
  const fridaServer = path.join(base, "frida-server");
  const backend = path.join(base, "headunit.py");
  const config = { phoneAvd: "Phone", receiverAvd: "Receiver", fridaServer, backend,
    python: process.env.HEADUNIT_PYTHON };
  await assert.rejects(startManagedProjection({ ...config, fridaServer: base }), /No Frida server file/);
  await writeFile(fridaServer, "");
  await writeFile(path.join(base, "open_headunit_session.py"), [
    "import sys",
    'print("A" * 21000, file=sys.stderr)',
    'print("Install frida-tools in the selected Python environment.", file=sys.stderr)',
    "sys.exit(1)",
  ].join("\n"));

  const missingPython = path.join(base, "python-missing");
  await assert.rejects(startManagedProjection({ ...config, python: missingPython }),
    /Install Python or set HEADUNIT_PYTHON/);
  await assert.rejects(startManagedProjection(config), (error) => {
    assert.match(error.message, /exited before becoming ready/);
    assert.match(error.message, /Install frida-tools in the selected Python environment\.$/);
    assert.ok(error.message.length < 17000);
    return true;
  });

  const entry = fileURLToPath(new URL("../provider/cli/install.mjs", import.meta.url));
  const install = spawnSync(process.execPath, [entry, "--help"], {
    env: { ...process.env, HEADUNIT_PYTHON: missingPython },
    encoding: "utf8",
  });
  assert.equal(install.status, 1);
  assert.match(install.stderr, /Install Python or set HEADUNIT_PYTHON/);
});
