import { setTimeout as sleep } from "node:timers/promises";

const receiverPackage = "com.andrerinas.headunitrevived";
const receiverClass = "com.andrerinas.openheadunit";
const operations = ["setOrientation", "unlockOrientation"];
const projectionRotationTimeoutMs = 35000;
const rotationIndices = new Map([
  ["portrait", 0], ["landscape-left", 1], ["portrait-upside-down", 2], ["landscape-right", 3],
]);
const unavailable = Object.freeze({ available: false, reason: "owner-capability-missing" });

export function receiverOrientationFacts(nativeReceiverFacts, live) {
  return Object.fromEntries(operations.map((operation) => [
    operation, live ? nativeReceiverFacts?.operations?.[operation] ?? unavailable : unavailable,
  ]));
}

function orientationSetting(xml) {
  if (!/^\s*(?:<\?xml[^>]+>\s*)?<map(?:\s*\/>|>[\s\S]*<\/map>)\s*$/.test(xml)) return undefined;
  const entries = [...xml.matchAll(/<[A-Za-z]+\b[^>]*\bname="screen-orientation"[^>]*>/g)];
  if (entries.length === 0) return 0;
  if (entries.length === 1 && /^<int\b/.test(entries[0][0])) {
    const value = /\bvalue="([0-5])"/.exec(entries[0][0]);
    if (value) return Number(value[1]);
  }
}

function exportedOrientation(stdout) {
  const result = /^Broadcast completed: result=0, data="(\{[^\r\n]*\})"\r?$/m.exec(stdout);
  if (!result) return undefined;
  try {
    const { ok, settings } = JSON.parse(result[1]);
    if (ok !== true || !["open-headunit-settings", "headunit-revived-settings"].includes(settings?.format) ||
        !settings.settings || typeof settings.settings !== "object" || Array.isArray(settings.settings)) return undefined;
    const value = settings.settings["screen-orientation"] ?? 0;
    if (Number.isInteger(value) && value >= 0 && value <= 5) return value;
  } catch {
    return undefined;
  }
}

function primaryDisplay(stdout) {
  for (const source of ["Override", "Base"]) {
    const lines = stdout.split(/\r?\n/).filter((line) =>
      line.trimStart().startsWith(`m${source}DisplayInfo=DisplayInfo{`) && /, displayId 0,/.test(line));
    if (lines.length > 1) return undefined;
    if (lines.length === 1) {
      const size = /, real ([1-9]\d*) x ([1-9]\d*),/.exec(lines[0]);
      const rotation = /, rotation ([0-3]),/.exec(lines[0]);
      if (size && rotation && size[1] !== size[2]) {
        return { index: Number(rotation[1]), landscape: Number(size[1]) > Number(size[2]) };
      }
      return undefined;
    }
  }
}

function receiverOnPrimary(stdout) {
  const displays = stdout.split(/^[ \t]*Display #(\d+) \(activities from top to bottom\):[ \t]*\r?$/m);
  const primaryIndex = displays.indexOf("0", 1);
  if (primaryIndex < 0) return false;
  const primary = displays[primaryIndex + 1];
  const activity = `${receiverPackage}/${receiverClass}.aap.AapProjectionActivity`;
  const lines = primary.split(/\r?\n/);
  const top = lines.filter((line) => /^[ \t]*topResumedActivity[:=][ \t]*ActivityRecord\{/.test(line));
  const resumed = top.length ? top : lines.filter((line) =>
    /^[ \t]*(?:Resumed:|mResumedActivity[:=])[ \t]*ActivityRecord\{/.test(line));
  return resumed.length > 0 && resumed.every((line) => line.includes(` ${activity} `));
}

export function bindReceiverOrientationOperations({
  facts, bindNative, readLayout, updateLayout, runAdbShell, receiverDevice, phoneSerial, scope, createError,
}) {
  const { signal } = scope;
  const adb = (args) => runAdbShell(receiverDevice, args, {
    allowFailure: true, timeoutMs: 4000,
  }, signal);

  async function verifySystemMode() {
    const local = await adb(["run-as", receiverPackage, "cat", "shared_prefs/settings.xml"]);
    let mode = local.exitCode === 0 ? orientationSetting(local.stdout) : undefined;
    if (mode === undefined) {
      const exported = await adb(["am", "broadcast", "-n", `${receiverPackage}/${receiverClass}.automation.AutomationReceiver`,
        "-a", `${receiverClass}.ACTION_GET_SETTINGS`]);
      mode = exported.exitCode === 0 ? exportedOrientation(exported.stdout) : undefined;
    }
    if (mode !== 0) {
      throw createError("UNSUPPORTED_OPERATION", mode === undefined
        ? "Could not verify Open Headunit’s System orientation mode. Enable external configuration on the receiver."
        : "Set Open Headunit’s screen orientation to System before rotating the projection.", { dispatched: "no" });
    }
  }

  function layoutAspect(layout) {
    if (layout.serial !== phoneSerial || layout.receiver !== receiverDevice.id) {
      throw createError("DEVICE_NOT_FOUND", "The Open Headunit projection changed devices.");
    }
    const { width, height } = layout.viewport ?? {};
    if (!(width > 0 && height > 0 && width !== height && layout.displays?.length)) {
      throw createError("COMMAND_FAILED", "Android Auto did not report a car display aspect.");
    }
    return width > height;
  }

  async function display() {
    const result = await adb(["dumpsys", "display"]);
    return result.exitCode === 0 ? primaryDisplay(result.stdout) : undefined;
  }

  async function waitForProjection(index) {
    const deadline = Date.now() + projectionRotationTimeoutMs;
    do {
      signal.throwIfAborted();
      scope.checkDeadline?.();
      const receiver = await display();
      if (receiver && (index === undefined || receiver.index === index)) {
        let layout;
        try {
          layout = await readLayout(signal);
        } catch {
          // The car layout can disappear while the receiver negotiates the new aspect.
          signal.throwIfAborted();
        }
        if (layout && layoutAspect(layout) === receiver.landscape) return layout;
      }
      if (Date.now() < deadline) await sleep(250, undefined, { signal });
    } while (Date.now() < deadline);
    throw createError("COMMAND_FAILED", "The receiver and Android Auto did not settle on the same orientation.");
  }

  async function change(operation, input) {
    const rotation = input?.rotation;
    const index = rotationIndices.get(rotation);
    if (operation === "setOrientation" && index === undefined) {
      throw createError("INVALID_ARGS", "Specify one of the four Android orientation values.");
    }
    signal.throwIfAborted();
    layoutAspect(await readLayout(signal));
    await verifySystemMode();
    const activity = await adb(["dumpsys", "activity", "activities"]);
    const before = await display();
    if (!before || activity.exitCode !== 0 || !receiverOnPrimary(activity.stdout)) {
      throw createError("UNSUPPORTED_OPERATION", "The active Open Headunit window is not on its primary display.", { dispatched: "no" });
    }
    if (index !== undefined && before.landscape !== Boolean(before.index % 2)) {
      throw createError("UNSUPPORTED_OPERATION", "Android orientation values require a portrait natural receiver display.", { dispatched: "no" });
    }

    await bindNative(async (binding) => {
      const method = binding.operations[operation];
      if (!binding.facts.operations[operation]?.available || typeof method !== "function") {
        throw createError("UNSUPPORTED_OPERATION", "The receiver’s Android runtime cannot change orientation.", { dispatched: "no" });
      }
      await method(index === undefined ? {} : { rotation });
    });
    const mode = await adb(["wm", "user-rotation"]);
    const expectedMode = index === undefined ? "free" : `lock ${index}`;
    if (mode.exitCode !== 0 || mode.stdout.trim() !== expectedMode) {
      throw createError("COMMAND_FAILED", "Android did not apply the receiver rotation mode.");
    }
    const layout = await waitForProjection(index);
    updateLayout?.(layout);
    if (index !== undefined) return { orientation: rotation };
  }

  return Object.fromEntries(operations.filter((operation) => facts[operation]?.available)
    .map((operation) => [operation, (input) => change(operation, input)]));
}
