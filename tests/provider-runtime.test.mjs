import test from "node:test";
import assert from "node:assert/strict";
import { directRuntime, projectionId } from "../provider/provider-runtime.mjs";
import { upstreamVersion } from "../provider/upstream-runtime.mjs";

test("timed gesture capabilities follow the selected projection's staged touch helper", async () => {
  const device = { id: projectionId("emulator-5554", "emulator-5556"), platform: "android", target: "mobile", kind: "emulator" };
  const names = ["performGesturePlan", "performDirectionalFlingPlan", "performMultiTouchGesturePlan", "performTargetAuthoredDrag"];
  const facts = { device: { kind: "device" }, operations: Object.fromEntries(names.map((name) => [name, { available: true }])) };
  const operations = Object.fromEntries(names.map((name) => [name, async () => {}]));
  const controller = {};
  const { platformModule } = await directRuntime({}, { env: {} }, {
    createCloudWebDriverRuntime: async () => ({
      deviceInventoryProvider: async () => [], getInteractor: () => ({}),
      platformRuntimeModule: { owner: {}, loadRuntime: async () => ({
        inspectFacts: async () => facts,
        bind: async () => ({ facts, operations, [Symbol.asyncDispose]: async () => {} }),
      }) },
    }),
    createAndroidPlatformRuntime: () => ({ inspectFacts: async () => ({ operations: {} }) }),
    deviceIdentity: (target) => target,
  }, undefined, new Set([device.id]), new Map([[device.id, controller]]));
  const owner = await platformModule.loadRuntime({});
  const request = { device, intent: { kind: "ordinary" }, scope: { signal: new AbortController().signal } };
  const basic = await owner.bind(request);
  assert.equal(basic.operations.performGesturePlan, operations.performGesturePlan);
  for (const name of names.slice(1)) {
    assert.equal((await owner.inspectFacts(device)).operations[name].available, false);
    assert.equal(basic.facts.operations[name].available, false);
    assert.equal(basic.operations[name], undefined);
  }
  controller.touch = { jar: "/data/local/tmp/headunit-touch-0123456789abcdef.jar", root: "adb-root" };
  const full = await owner.bind(request);
  for (const name of names) {
    assert.equal((await owner.inspectFacts(device)).operations[name].available, true);
    assert.equal(full.facts.operations[name].available, true);
    assert.equal(full.operations[name], operations[name]);
  }
});

test("the bound projection reads the current actionable pane while preserving the full canvas", async () => {
  const phone = "emulator-5554", receiver = "emulator-5556";
  const device = { id: projectionId(phone, receiver), platform: "android", target: "mobile", kind: "emulator" };
  const scope = { signal: new AbortController().signal };
  const viewport = { x: 0, y: 0, width: 1000, height: 600 };
  const left = { appFocused: true, carBounds: [-11, 17, 589, 517], width: 301, height: 251,
    hitRegions: [[0, 0, 301, 19], [11, 50, 280, 240]] };
  const right = { carBounds: [410, 12, 1010, 612], width: 300, height: 300, hitRegions: [[20, 25, 300, 300]] };
  const scenes = [[left, right], [{ ...left, appFocused: false }, { ...right, appFocused: true }],
    [left, { ...right, appFocused: true }], [{ ...left, hitRegions: [[20, 50, 400, 210]] }]];
  const controller = {
    viewport: () => assert.fail("Cached viewport should not be read"),
    async call(request, signal) {
      assert.deepEqual(request, { op: "layout", serial: phone });
      assert.equal(signal, scope.signal);
      return { ok: true, viewport, displays: scenes.shift() };
    },
  };
  const facts = { device: { kind: "device" }, operations: {} };
  const { platformModule } = await directRuntime({}, { env: {} }, {
    createCloudWebDriverRuntime: async () => ({ deviceInventoryProvider: async () => [], getInteractor: () => ({}),
      platformRuntimeModule: { owner: {}, loadRuntime: async () => ({
        bind: async () => ({ facts, operations: {}, [Symbol.asyncDispose]: async () => {} }),
      }) },
    }),
    createAndroidPlatformRuntime: () => ({ inspectFacts: async () => ({ operations: {} }) }),
    deviceIdentity: (target) => target,
  }, () => assert.fail("Expected the active lease RPC"), new Set([device.id]), new Map([[device.id, controller]]));
  const owner = await platformModule.loadRuntime({});
  const binding = await owner.bind({ device, intent: { kind: "ordinary" }, scope });
  assert.deepEqual(await binding.operations.gestureViewport(), { ...viewport,
    implicitOriginViewport: { x: 11, y: 117, width: 537, height: 379 } });
  assert.deepEqual(await binding.operations.gestureViewport(), { ...viewport,
    implicitOriginViewport: { x: 450, y: 62, width: 550, height: 538 } });
  assert.deepEqual(await binding.operations.gestureViewport(), viewport);
  assert.deepEqual(await binding.operations.gestureViewport(), viewport);
  assert.equal(scenes.length, 0);
});

test("recording runs on the receiver and preserves the projection ownership on recovery", async () => {
  const owner = { kind: "provider-runtime", provider: "headunit", instance: "android" };
  const localOwner = { kind: "local-family", family: "android" };
  const facts = { device: { kind: "device" }, operations: { screenRecordingStart: { available: false } } };
  const nativeFacts = { operations: { volumeUp: { available: true }, volumeDown: { available: true }, mute: { available: true },
    sendTelephonyEvent: { available: true }, setSetting: {
    available: true, subjects: { "keep-awake": { available: true }, location: { available: true } },
    unlisted: { available: false, reason: "unsupported-platform-leaf" },
  } } };
  const device = { id: projectionId("emulator-5554", "emulator-5556"), platform: "android", target: "mobile", kind: "emulator" };
  const driverDevice = { ...device, kind: "device" };
  const deviceIdentity = ({ id, platform, target, kind }) => ({ id, family: platform, target, kind });
  const fence = { token: "recording-lease", generation: 1 };
  const calls = [];
  const keyboard = [];
  const settings = [];
  const volume = [];
  const telephony = [];
  const checkedServices = [];
  const emulatorIds = new Set([device.id]);
  let active = true;
  const driver = {
    ownsDevice: () => active,
    inspectFacts: async (target) => { assert.deepEqual(target, driverDevice); return facts; },
    bind: async (request) => {
      assert.deepEqual(request.device, driverDevice);
      return {
        facts, operations: { captureSnapshot: "unchanged", ensureReady: async () => ({ ...request.device, booted: true }),
          openApplication: async () => ({ timing: { stock: true } }) },
        [Symbol.asyncDispose]: async () => {},
      };
    },
  };
  const runtime = {
    deviceInventoryProvider: async () => [driverDevice],
    getInteractor: () => active ? {} : undefined,
    platformRuntimeModule: { owner, loadRuntime: async () => driver },
  };
  const sdk = {
    createCloudWebDriverRuntime: async () => runtime,
    createAndroidPlatformRuntime: () => ({
      inspectFacts: async () => nativeFacts,
      async bind(request) {
        calls.push({ id: request.device.id, intent: request.intent });
        const native = { device: deviceIdentity(request.device), owner: localOwner };
        return {
          device: request.device,
          owner: localOwner,
          facts: nativeFacts,
          operations: {
            ...Object.fromEntries(["volumeUp", "volumeDown", "mute"].map((button) => [button, async () => {
              volume.push({ serial: request.device.id, button });
            }])),
            sendTelephonyEvent: async (input) => {
              telephony.push({ serial: request.device.id, input });
            },
            listApps: async ({ device: target, filter }) => {
              assert.equal(target.id, "emulator-5554");
              assert.equal(filter, "user-installed");
              return [{ id: "example.fixture" }];
            },
            setSetting: async (input) => {
              settings.push({ serial: request.device.id, kind: request.device.kind, input });
              return input.setting === "keep-awake" ? { keepAwake: "enabled" } : input.options;
            },
            screenRecordingStart: async (input) => ({ envelope: { ...native, fence: input.fence } }),
            screenRecordingReattach: async ({ envelope }) => {
              assert.deepEqual(envelope, { ...native, fence });
              return { status: "active" };
            },
          },
          [Symbol.asyncDispose]: async () => { calls.push("disposed"); },
        };
      },
    }),
    deviceIdentity,
    deviceShellArgv: (tool, action, words) => {
      assert.equal(tool, "adb");
      return [action, ...words];
    },
  };

  const { platformModule, runtime: providerRuntime } = await directRuntime({}, {
    clientVersion: upstreamVersion, env: { HEADUNIT_FRIDA_SESSION: "fixture" },
    createError: (code, message, details) => Object.assign(new Error(message), { code, details }),
  }, sdk, async (request) => {
    keyboard.push(request);
    if (request.op === "resolveApp" && request.target === "Second car app") {
      return { ok: true, package: "example.second", component: "example.second/example.second.CarLauncher" };
    }
    if (request.op === "resolveApp" && request.target === "Unknown car app") throw new Error("No unique launcher component");
    if (request.target === "example.second/example.second.CarLauncher") return { ok: true };
    return request.op === "keyboardStatus" ? { ok: true, kind: "ime-probe", visible: true } :
      { ok: true, package: "example.projected" };
  }, emulatorIds);
  let consoleReply = "OK\r\n";
  let telephonyStatus = "not found";
  const platform = await platformModule.loadRuntime({ androidTools: {
    async runAdb(target, args, options, signal) {
      assert.equal(target.id, "emulator-5554");
      assert.equal(target.kind, "emulator");
      assert.equal(options.allowFailure, true);
      assert.equal(signal.aborted, false);
      if (args[0] === "shell") {
        const service = args[3];
        assert.deepEqual(args, ["shell", "service", "check", service]);
        checkedServices.push(service);
        return { exitCode: 0, stdout: `Service ${service}: ${telephonyStatus}\r\n`, stderr: "" };
      }
      assert.deepEqual(args, ["emu", "geo", "fix", "-122", "37.5"]);
      return { exitCode: 0, stdout: consoleReply, stderr: "" };
    },
  } });
  assert.deepEqual(await providerRuntime.deviceInventoryProvider({}), [device]);
  assert.equal((await platform.inspectFacts(device)).operations.screenRecordingStart.available, true);
  const request = { device, intent: { kind: "ordinary" }, scope: { signal: new AbortController().signal } };
  const live = await platform.bind(request);
  assert.equal(live.operations.captureSnapshot, "unchanged");
  assert.equal(live.facts.operations.keyboardStatus.available, true);
  assert.deepEqual(await live.operations.keyboardStatus(), { kind: "ime-probe", visible: true });
  assert.deepEqual(keyboard, [{ op: "keyboardStatus", serial: "emulator-5554" }]);
  assert.deepEqual(await live.operations.ensureReady({}), { ...device, booted: true });
  for (const button of ["volumeUp", "volumeDown", "mute"]) {
    assert.equal(live.facts.operations[button].available, true);
    await live.operations[button]({});
  }
  assert.deepEqual(volume, ["volumeUp", "volumeDown", "mute"].map((button) => ({ serial: "emulator-5556", button })));
  const inboundCall = { action: "call", number: "5550108" };
  const inboundMessage = { action: "sms", number: "5550109", text: "Test message" };
  await assert.rejects(live.operations.sendTelephonyEvent(inboundCall), {
    code: "UNSUPPORTED_OPERATION",
    details: { deviceId: "emulator-5554", reason: "headunit_telephony_service_unavailable", dispatched: "no" },
  });
  assert.deepEqual(telephony, []);
  telephonyStatus = "found";
  await live.operations.sendTelephonyEvent(inboundMessage);
  assert.deepEqual(checkedServices, ["phone", "isms"]);
  assert.deepEqual(telephony, [{ serial: "emulator-5554", input: inboundMessage }]);
  calls.length = 0;
  assert.equal(live.facts.device.kind, "emulator");
  assert.deepEqual(await live.operations.appState(), { package: "example.projected" });
  assert.equal(live.facts.operations.triggerAppEvent.available, true);
  await live.operations.triggerAppEvent({ eventUrl: "fixture://event", options: { appBundleId: "example.projected" } });
  assert.deepEqual(keyboard.at(-1), { op: "deepLink", serial: "emulator-5554",
    target: "example.projected", url: "fixture://event" });
  assert.deepEqual(await live.operations.openApplication({ positionals: ["example.projected"], relaunch: true }),
    { appBundleId: "example.projected", timing: {} });
  assert.deepEqual(keyboard.at(-1), { op: "relaunch", serial: "emulator-5554", target: "example.projected" });
  assert.deepEqual(await live.operations.openApplication({ positionals: ["example.projected"] }),
    { timing: { stock: true } });
  assert.deepEqual(await live.operations.openApplication({
    positionals: ["example.projected/.CarLauncher"], appBundleId: "example.projected",
  }), { appBundleId: "example.projected", timing: {} });
  assert.deepEqual(keyboard.at(-1), {
    op: "open", serial: "emulator-5554", target: "example.projected/.CarLauncher",
  });
  for (const relaunch of [false, true]) {
    assert.deepEqual(await live.operations.openApplication({
      positionals: ["Second car app"], appBundleId: "example.current", relaunch,
    }), { appBundleId: "example.second", timing: {} });
    assert.deepEqual(keyboard.slice(-2), [
      { op: "resolveApp", serial: "emulator-5554", target: "Second car app", arguments: undefined },
      { op: relaunch ? "relaunch" : "open", serial: "emulator-5554", target: "example.second/example.second.CarLauncher" },
    ]);
  }
  const ordinaryDispatches = keyboard.length;
  for (const positionals of [[], ["Android Auto"], ["Open Headunit"], ["com.google.android.projection.gearhead"]]) {
    assert.deepEqual(await live.operations.openApplication({ positionals, appBundleId: "example.current" }),
      { timing: { stock: true } });
  }
  assert.equal(keyboard.length, ordinaryDispatches);
  await assert.rejects(live.operations.openApplication({
    positionals: ["Unknown car app"], appBundleId: "example.current", relaunch: true,
  }), /No unique launcher component/);
  assert.deepEqual(keyboard.slice(ordinaryDispatches), [
    { op: "resolveApp", serial: "emulator-5554", target: "Unknown car app", arguments: undefined },
  ]);
  const launchArgs = ["--es", "entry", "projected"];
  assert.deepEqual(await live.operations.openApplication({
    positionals: ["example.projected"], relaunch: true, execution: { launchArgs },
  }), { appBundleId: "example.projected", timing: {} });
  assert.deepEqual(keyboard.at(-1), {
    op: "openWithExtras", serial: "emulator-5554", target: "example.projected", arguments: launchArgs, relaunch: true,
  });
  await live.operations.openApplication({
    positionals: ["example.projected", "fixture://view"], relaunch: true, execution: { launchArgs },
  });
  assert.deepEqual(keyboard.at(-1), {
    op: "deepLink", serial: "emulator-5554", target: "example.projected", url: "fixture://view",
    arguments: launchArgs, relaunch: true,
  });
  await live.operations.openApplication({
    positionals: ["example.projected/.CarLauncher"], relaunch: true, execution: { activity: ".Details" },
  });
  assert.deepEqual(keyboard.at(-1), {
    op: "openWithExtras", serial: "emulator-5554", target: "example.projected/.CarLauncher",
    activity: ".Details", arguments: [], relaunch: true,
  });
  const dispatches = keyboard.length;
  for (const positionals of [["fixture://view"], ["example.projected", "fixture://view"]]) {
    await assert.rejects(live.operations.openApplication({
      positionals, appBundleId: "example.projected", execution: { activity: ".Details" },
    }), { code: "INVALID_ARGS", details: { dispatched: "no" } });
  }
  assert.equal(keyboard.length, dispatches);
  await live.operations.openApplication({
    positionals: ["example.projected"], appBundleId: "example.projected", runtimeLaunchUrl: "fixture://ready",
  });
  assert.deepEqual(keyboard.at(-1), {
    op: "deepLink", serial: "emulator-5554", target: "example.projected", url: "fixture://ready",
  });
  assert.deepEqual(await live.operations.listApps({ device, filter: "user-installed" }), [{ id: "example.fixture" }]);
  assert.equal(live.facts.operations.setSetting.subjects["keep-awake"].available, true);
  assert.equal(live.facts.operations.setSetting.subjects.location.available, true);
  assert.equal(live.facts.operations.setSetting.subjects["clear-app-state"].available, false);
  const keepAwake = { setting: "keep-awake", state: "on" };
  const fix = { setting: "location", state: "set", options: { latitude: 37.5, longitude: -122 } };
  assert.deepEqual(await live.operations.setSetting(keepAwake), { keepAwake: "enabled" });
  assert.deepEqual(await live.operations.setSetting(fix), fix.options);
  consoleReply = "KO: authentication token does not match\r\nKO: unknown command\r\n";
  await assert.rejects(live.operations.setSetting(fix), { code: "COMMAND_FAILED" });
  await assert.rejects(live.operations.setSetting({ setting: "clear-app-state", state: "clear" }), {
    code: "UNSUPPORTED_OPERATION", details: { reason: "unsupported-platform-leaf", dispatched: "no" },
  });
  emulatorIds.delete(device.id);
  const unverified = await platform.bind(request);
  await assert.rejects(unverified.operations.setSetting(fix), {
    code: "UNSUPPORTED_OPERATION", details: { dispatched: "no" },
  });
  const toggle = { setting: "location", state: "off" };
  await unverified.operations.setSetting(toggle);
  assert.deepEqual(settings, [
    { serial: "emulator-5554", kind: "emulator", input: keepAwake },
    { serial: "emulator-5554", kind: "device", input: toggle },
  ]);
  const { envelope } = await live.operations.screenRecordingStart({ fence });
  assert.deepEqual(envelope, { device: deviceIdentity(device), owner, fence });

  active = false;
  assert.equal(platform.ownsDevice(device), true);
  const recovery = await platform.bind({ device, intent: { kind: "exact-owner", owner, fence } });
  assert.equal(recovery.facts.operations.screenRecordingStart.available, false);
  assert.equal(recovery.facts.operations.screenRecordingReattach.available, true);
  assert.equal(recovery.operations.keyboardStatus, undefined);
  assert.equal(recovery.operations.listApps, undefined);
  assert.equal(recovery.operations.setSetting, undefined);
  assert.deepEqual(await recovery.operations.screenRecordingReattach({ envelope }), { status: "active" });
  assert.deepEqual(calls, [
    { id: "emulator-5554", intent: { kind: "ordinary" } }, "disposed",
    { id: "emulator-5554", intent: { kind: "ordinary" } }, "disposed",
    { id: "emulator-5554", intent: { kind: "ordinary" } }, "disposed",
    { id: "emulator-5556", intent: { kind: "ordinary" } }, "disposed",
    { id: "emulator-5556", intent: { kind: "ordinary" } }, "disposed",
  ]);
});

test("app settings resolve aliases on the projecting phone before changing an exact package", async () => {
  const owner = { kind: "provider-runtime", provider: "headunit", instance: "android" };
  const shell = "com.google.android.projection.gearhead";
  const device = { id: projectionId("emulator-5554", "emulator-5556"), platform: "android",
    target: "mobile", kind: "emulator" };
  const baseFacts = { device: { kind: "device" }, operations: {} };
  const nativeFacts = { operations: { setSetting: { available: true } } };
  const changes = [];
  const reads = [];
  let user = 10;
  const createError = (code, message, details) => Object.assign(new Error(message), { code, details });
  const binding = (facts, operations = {}) => ({ facts, operations, [Symbol.asyncDispose]: async () => {} });
  const { platformModule } = await directRuntime({}, { env: {}, createError }, {
    createCloudWebDriverRuntime: async () => ({
      deviceInventoryProvider: async () => [],
      getInteractor: () => ({}),
      platformRuntimeModule: { owner, loadRuntime: async () => ({
        inspectFacts: async () => baseFacts,
        bind: async () => binding(baseFacts),
      }) },
    }),
    createAndroidPlatformRuntime: () => ({
      inspectFacts: async () => nativeFacts,
      bind: async ({ device }) => binding(nativeFacts, {
        setSetting: async (input) => { changes.push({ serial: device.id, ...input }); },
      }),
    }),
    readAndroidCurrentUserId: async (target) => {
      reads.push(["user", target.id]);
      return user;
    },
    resolveAndroidApp: async (target, alias, options) => {
      reads.push(["resolve", target.id, alias, options]);
      if (alias === "settings") return { type: "intent", value: "android.settings.SETTINGS" };
      if (alias === "gearhead") return { type: "package", value: shell };
      if (alias === "ambiguous") throw createError("INVALID_ARGS", "Multiple packages matched");
      return { type: "package", value: "lab.headunit.fixture" };
    },
    deviceIdentity: ({ id }) => ({ id }),
  }, undefined, new Set([device.id]));
  const runtime = await platformModule.loadRuntime({});
  const { operations } = await runtime.bind({
    device, intent: { kind: "ordinary" }, scope: { signal: new AbortController().signal },
  });
  const permission = { setting: "permission", state: "grant", appBundleId: "fixture",
    options: { permissionTarget: "camera" } };
  await operations.setSetting(permission);
  await operations.setSetting({ setting: "clear-app-state", state: "clear", appBundleId: "fixture" });
  assert.deepEqual(reads, [
    ["user", "emulator-5554"],
    ["resolve", "emulator-5554", "fixture", { installedOnly: true, userId: 10 }],
    ["resolve", "emulator-5554", "fixture", { installedOnly: true, userId: undefined }],
  ]);
  assert.deepEqual(changes, [
    { ...permission, serial: "emulator-5554", appBundleId: "lab.headunit.fixture" },
    { setting: "clear-app-state", state: "clear", serial: "emulator-5554", appBundleId: "lab.headunit.fixture" },
  ]);
  await assert.rejects(operations.setSetting({ ...permission, appBundleId: "settings" }), {
    code: "INVALID_ARGS", details: { reason: "setting_app_not_package", dispatched: "no" },
  });
  await assert.rejects(operations.setSetting({ ...permission, appBundleId: "gearhead" }), /Select the projected app/);
  await assert.rejects(operations.setSetting({ ...permission, appBundleId: shell }), /Select the projected app/);
  await assert.rejects(operations.setSetting({ ...permission, appBundleId: "ambiguous" }), /Multiple packages matched/);
  user = undefined;
  await assert.rejects(operations.setSetting(permission), /Could not determine the current Android user/);
  assert.equal(changes.length, 2);
});
