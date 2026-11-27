import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { metroPorts } from "../provider/metro-runtime.mjs";
import { projectedMetroOperations } from "../provider/projected-metro.mjs";

const serial = "emulator-5554";
const input = { provider: "headunit", leaseId: "old", devicePort: 8081, hostPort: 8082, name: "metro" };

test("Metro resolves a new projected label before touching the current session app", async () => {
  const calls = [];
  const phone = { id: serial };
  const component = "example.second/example.second.Selected";
  const apps = [
    { profile: "PERSONAL", package: "example.current", component: "example.current/example.current.Launcher" },
    { profile: "PERSONAL", package: "example.second", component },
    { profile: "PERSONAL", package: "example.second", component: "example.second/example.second.Other" },
  ];
  const metro = projectedMetroOperations({
    async openApplication(request) {
      assert.deepEqual(request.positionals, [component]);
      assert.equal(request.appBundleId, "example.second");
      assert.equal(request.target, component);
      assert.equal(request.relaunch, false);
      calls.push(["open", component]);
      return { appBundleId: request.appBundleId, timing: {} };
    },
    applications: { async applyRuntimeHints(device, { appId }) {
      assert.equal(device, phone);
      calls.push(["hints", appId]);
    } },
    phone,
    leaseId: "lease",
    readCatalog: async () => ({ apps }),
    async resolveLabel({ positionals: [target] }) {
      calls.push(["resolve", target]);
      if (target === "Missing app") throw new Error("No unique launcher component");
      return { package: "example.second", component };
    },
    async runAdbShell(device, args) {
      assert.equal(device, phone);
      assert.deepEqual(args, ["run-as", "example.second", "id"]);
      calls.push(["sandbox", "example.second"]);
      return { exitCode: 0, stdout: "uid=10001", stderr: "" };
    },
    async reverse({ devicePort }) {
      calls.push(["reverse", devicePort]);
      return true;
    },
    async closeProjected(target) { calls.push(["close", target]); },
    createError: (code, message, details) => Object.assign(new Error(message), { code, details }),
  });
  const open = (target) => metro.openApplication({
    target,
    positionals: [target],
    appBundleId: "example.current",
    relaunch: true,
    runtimeHints: {
      values: { metroHost: "127.0.0.1", metroPort: 8082 },
      apply: (hints) => metro.applyRuntimeHints(hints),
    },
  });
  await assert.rejects(open("Missing app"), /No unique launcher component/);
  assert.deepEqual(calls.splice(0), [["resolve", "Missing app"]]);
  const result = await open("Second app");
  assert.equal(result.appBundleId, "example.second");
  assert.ok(result.timing.relaunchCloseDurationMs >= 0);
  assert.deepEqual(calls, [
    ["resolve", "Second app"], ["sandbox", "example.second"], ["reverse", 8082],
    ["close", component], ["hints", "example.second"], ["open", component],
  ]);
});

test("a new lease reconciles a failed cleanup using the original transport and marker", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "headunit-metro-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, transportId: "12", assertHeld() {} };
  const initial = [];
  const ports = metroPorts(async (request) => {
    initial.push(request);
    if (request.remove) throw new Error("ADB temporarily unavailable");
    return { created: true };
  }, serial, "old", options);

  assert.deepEqual(await ports.configure(input), { leaseId: "old", devicePort: 8081, hostPort: 8082, name: "metro" });
  await assert.rejects(ports.cleanup(), /Could not release/);
  assert.equal(initial[0].transportId, "12");
  assert.match(initial[0].token, /^[a-f0-9]{32}$/);
  assert.deepEqual(initial[1], { ...initial[0], remove: true });

  const recovered = [];
  const replacement = metroPorts(async (request) => {
    recovered.push(request);
    return { created: false };
  }, serial, "new", { ...options, transportId: "15" });
  await replacement.configure({ ...input, leaseId: "new" });
  assert.deepEqual(recovered[0], initial[1]);
  assert.equal(recovered[1].transportId, "15");
  assert.notEqual(recovered[1].token, initial[0].token);
  await replacement.cleanup();
  assert.equal(recovered.length, 2);
  const [directory] = await readdir(root);
  assert.deepEqual(await readdir(path.join(root, directory)), []);
});

test("failed create remains durable when its immediate reconciliation also fails", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "headunit-metro-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, transportId: "12", assertHeld() {} };
  const requests = [];
  const ports = metroPorts(async (request) => {
    requests.push(request);
    throw new Error("ADB temporarily unavailable");
  }, serial, "old", options);
  await assert.rejects(ports.configure(input), AggregateError);
  assert.deepEqual(requests[1], { ...requests[0], remove: true });

  const reopened = metroPorts(async (request) => { requests.push(request); }, serial, "new", options);
  await reopened.cleanup();
  assert.deepEqual(requests[2], requests[1]);
});
