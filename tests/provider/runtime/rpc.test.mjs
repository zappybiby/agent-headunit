import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rpcClient, sessionRpcClient } from "../../../provider/runtime/rpc.mjs";

test("acknowledges a completed command while a helper still holds its pipes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "headunit-rpc-"));
  const backend = path.join(dir, "reply.py");
  const release = path.join(dir, "release");
  const helper = [
    "import os, sys, time",
    "deadline = time.monotonic() + 90",
    "while time.monotonic() < deadline:",
    "    if not os.path.isdir(os.path.dirname(sys.argv[1])) or os.path.exists(sys.argv[1]): break",
    "    time.sleep(0.05)",
  ].join("\n");
  try {
    await writeFile(backend, [
      "import json, subprocess, sys",
      "json.load(sys.stdin)",
      `subprocess.Popen([sys.executable, "-c", ${JSON.stringify(helper)}, ${JSON.stringify(release)}], stdout=sys.stdout, stderr=sys.stderr)`,
      'print(json.dumps({"ok": True, "applied": True}))',
    ].join("\n"));
    const call = rpcClient({ backend }, { env: {} });
    assert.deepEqual(await call({ op: "tap" }), { ok: true, applied: true });
  } finally {
    await writeFile(release, "");
    await rm(dir, { recursive: true, force: true });
  }
});

test("keeps one worker per session and only sends each command once", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "headunit-worker-"));
  const backend = path.join(dir, "worker.py");
  const received = path.join(dir, "received");
  const call = sessionRpcClient({ backend }, { env: {} }, { RECEIVED: received });
  t.after(async () => {
    await call.close();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(backend, [
    "import json, os, sys",
    'assert sys.argv[1:] == ["rpc-worker"]',
    "for line in sys.stdin:",
    '    op = json.loads(line)["op"]',
    '    with open(os.environ["RECEIVED"], "a") as log: print(op, file=log)',
    '    if op == "crash": os._exit(7)',
    '    print(json.dumps({"ok": op != "refuse", "pid": os.getpid(), "error": "Control moved"}), flush=True)',
  ].join("\n"));

  const { pid } = await call({ op: "first" });
  await assert.rejects(call({ op: "refuse" }), /Control moved/);
  const inFlight = call({ op: "second" });
  const cancellation = new AbortController();
  const skipped = assert.rejects(call({ op: "skip" }, cancellation.signal), /Skip queued command/);
  cancellation.abort(new Error("Skip queued command"));
  await skipped;
  assert.equal((await inFlight).pid, pid);

  await assert.rejects(call({ op: "crash" }), /exited|closed its response stream/);
  const restarted = await call({ op: "after crash" });
  assert.notEqual(restarted.pid, pid);
  assert.deepEqual((await readFile(received, "utf8")).trim().split(/\r?\n/),
    ["first", "refuse", "second", "crash", "after crash"]);

  const abortActive = new AbortController();
  const interrupted = assert.rejects(call({ op: "interrupt" }, abortActive.signal), /Cancel active command/);
  const afterInterrupt = call({ op: "after interrupt" });
  abortActive.abort(new Error("Cancel active command"));
  await interrupted;
  assert.notEqual((await afterInterrupt).pid, restarted.pid);
  await call.close();
  await assert.rejects(call({ op: "closed" }), /session has closed/);
});

test("the Python worker replies to successive commands on the same pipes", async (t) => {
  const call = sessionRpcClient({}, { env: {} });
  t.after(() => call.close());
  const close = { op: "close", target: "Android Auto" };
  assert.deepEqual(await call(close), { ok: true });
  await assert.rejects(call({}), /op/);
  assert.deepEqual(await call(close), { ok: true });
});
