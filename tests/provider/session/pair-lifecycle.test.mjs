import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ManagedProjectionCleanupError, startManagedProjection } from "../../../provider/session/managed-projection.mjs";
import { createPairLifecycle } from "../../../provider/session/pair-lifecycle.mjs";

async function consoleFixture(t) {
  const server = createServer();
  const close = () => server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
  t.after(close);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { serial: `emulator-${server.address().port}`, close };
}

test("pair shutdown retries each unfinished phase and retains the lease until both pinned emulators stop", async (t) => {
  const temp = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(temp, "headunit-shutdown-test-"));
  t.after(async () => {
    assert.equal(path.dirname(dir), temp);
    assert.match(path.basename(dir), /^headunit-shutdown-test-/);
    await rm(dir, { recursive: true, force: true });
  });
  const [phone, receiver] = await Promise.all([consoleFixture(t), consoleFixture(t)]);
  const fakeServer = path.join(dir, "fake-server");
  await writeFile(fakeServer, "not executable");
  await writeFile(path.join(dir, "open_headunit_session.py"), [
    "import json, sys",
    `print(json.dumps(${JSON.stringify({ phone: phone.serial, receiver: receiver.serial, fridaSession: path.join(dir, "frida.json") })}), flush=True)`,
    "assert sys.stdin.buffer.read(1) == b'+'",
    "sys.stdin.buffer.read()",
    "print('Fixture launcher cleanup failed.', file=sys.stderr)",
    "sys.exit(17)",
  ].join("\n"));
  const managed = await startManagedProjection({ phoneAvd: "test-phone", receiverAvd: "test-receiver",
    fridaServer: fakeServer, backend: path.join(dir, "headunit.py"), python: process.env.HEADUNIT_PYTHON });
  t.after(() => managed.close().catch(() => {}));
  await managed.adopt();

  const transports = { [phone.serial]: "11", [receiver.serial]: "12" };
  const running = new Map(Object.entries(transports));
  const physicalStops = [];
  const releases = [];
  let projections = 0, portAttempts = 0, serviceAttempts = 0;
  const lifecycle = createPairLifecycle({ phone: phone.serial, receiver: receiver.serial, leaseId: "fixture-lease",
    transports, owns: () => true,
    checkProjection: async () => {
      projections++;
      return { serial: phone.serial, receiver: receiver.serial, emulators: true, displays: [{}] };
    },
    ports: { async cleanup() { if (++portAttempts === 1) throw new Error("Metro cleanup failed"); } },
    beforeStop: async () => {
      if (++serviceAttempts === 1) throw new Error("Transient service preparation failed");
      await managed.close();
    },
  });
  const host = {
    commands: { run: async ({ executable, args }) => {
      assert.equal(executable, "adb");
      assert.deepEqual(args, ["devices", "-l"]);
      const rows = [...running].map(([serial, transport]) => `${serial}\tdevice transport_id:${transport}`);
      return { exitCode: 0, stdout: ["List of devices attached", ...rows].join("\n") };
    } },
    deviceShutdown: { android: { async shutdownTarget({ id }) {
      physicalStops.push(id);
      if (id === phone.serial && physicalStops.length === 2) return { success: false, exitCode: 1 };
      await (id === phone.serial ? phone : receiver).close();
      running.delete(id);
      return { success: true, exitCode: 0 };
    } } },
  };
  const bind = () => lifecycle.bind({ host, device: { id: "projection" }, scope: { signal: AbortSignal.timeout(5000) },
    createError: (code, message) => Object.assign(new Error(message), { code }) });
  const shutdown = () => bind().shutdownTarget({ releaseLease: async (leaseId) => {
    assert.equal(lifecycle.stopped, true);
    assert.equal(running.size, 0);
    releases.push(leaseId);
    return { success: true };
  } });

  await assert.rejects(shutdown(), /Metro cleanup failed/);
  assert.equal(lifecycle.stopping, true);
  await assert.rejects(bind().ensureReady(), /shutdown is already in progress/);
  await assert.rejects(shutdown(), /Transient service preparation failed/);
  await assert.rejects(shutdown(), ManagedProjectionCleanupError);
  assert.deepEqual(physicalStops, []);
  await assert.rejects(shutdown(), /Could not stop the owned emulator/);
  assert.deepEqual(physicalStops, [receiver.serial, phone.serial]);
  assert.equal(lifecycle.stopped, false);
  assert.deepEqual(releases, []);
  assert.deepEqual(await shutdown(), { success: true });
  assert.deepEqual(physicalStops, [receiver.serial, phone.serial, phone.serial]);
  assert.deepEqual(releases, ["fixture-lease"]);
  assert.deepEqual([projections, portAttempts, serviceAttempts], [1, 2, 2]);
});
