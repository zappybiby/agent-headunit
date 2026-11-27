import { projectionDeviceFacts, projectionInventory, webDriverDevice } from "./projection-device.mjs";
import { bindPhoneOperations, phoneOperationFacts } from "./phone-runtime.mjs";
import { bindPhonePush } from "./phone-push.mjs";
import { appResourceFacts, bindAppResourceOperations } from "./app-resource-runtime.mjs";
import { metroFacts } from "./metro-runtime.mjs";
import { projectedMetroOperations } from "./projected-metro.mjs";
import { withPortableAppLogMarkers } from "./windows-app-log.mjs";
import { bindPairLifecycle, pairLifecycleFacts, usesLocalAdb } from "./pair-lifecycle.mjs";
import { bindReceiverAudioOperations, receiverAudioFacts } from "./receiver-audio.mjs";
import { createEmulatorAudioCaptureOperations } from "./emulator-audio-capture.mjs";
import { bindReceiverOrientationOperations, receiverOrientationFacts } from "./receiver-orientation.mjs";
import { bindReceiverVolumeOperations, receiverVolumeFacts } from "./receiver-volume.mjs";

const projectionPrefix = "headunit:android:";
const serialPattern = /^[a-zA-Z0-9._:/-]{1,128}$/;
const available = Object.freeze({ available: true });
const packageTarget = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+(?:\/[.\w$]+)?$/;
const linkTarget = /^[A-Za-z][\w+.-]*:/;
const projectionShell = "com.google.android.projection.gearhead";
const projectionAliases = new Set(["Android Auto", "Open Headunit"]);
const keyboardActions = ["keyboardStatus", "keyboardDismiss", "keyboardEnter"];
const keyboardFacts = Object.fromEntries(keyboardActions.map((op) => [op, available]));
const alertActions = { readAlert: "get", awaitAlert: "wait", acceptAlert: "accept", dismissAlert: "dismiss" };
const alertFacts = Object.fromEntries(Object.keys(alertActions).map((op) => [op, available]));
const phoneActions = [
  "listApps", "deployApp", "materializeAppSource", "deployMaterializedApp", "uninstallApp",
];
const phoneFacts = Object.fromEntries(phoneActions.map((op) => [op, available]));
const touchHelperUnavailable = Object.freeze({ available: false, reason: "owner-capability-missing",
  hint: "This gesture requires the Open Headunit touch helper on a rooted Android 16 or 17 phone." });
const touchHelperFacts = Object.freeze(Object.fromEntries([
  "performDirectionalFlingPlan", "performMultiTouchGesturePlan", "performTargetAuthoredDrag",
].map((operation) => [operation, touchHelperUnavailable])));

export function projectionId(phone, receiver) {
  if (typeof phone !== "string" || typeof receiver !== "string" || !serialPattern.test(phone) ||
      !serialPattern.test(receiver) || phone === receiver) {
    throw new Error("The projection needs distinct phone and receiver ADB serials.");
  }
  return projectionPrefix + Buffer.from(JSON.stringify([phone, receiver])).toString("base64url");
}

function projectionPair(device) {
  if (device.platform !== "android" || device.target !== "mobile" || !["device", "emulator"].includes(device.kind) ||
      typeof device.id !== "string" ||
      !device.id.startsWith(projectionPrefix) || device.id.length > 400) return;
  try {
    const pair = JSON.parse(Buffer.from(device.id.slice(projectionPrefix.length), "base64url").toString("utf8"));
    if (Array.isArray(pair) && pair.length === 2 && pair.every((serial) => typeof serial === "string") &&
        projectionId(...pair) === device.id) return pair;
  } catch {
    return undefined;
  }
}

function projectedGestureViewport({ viewport, displays }) {
  if (!Array.isArray(displays)) return viewport;
  const focused = displays.filter((panel) => panel?.appFocused && Array.isArray(panel.hitRegions) && panel.hitRegions.length);
  if (focused.length !== 1) return viewport;
  const { carBounds, width, height, hitRegions } = focused[0];
  if (!Array.isArray(carBounds) || carBounds.length !== 4 || !carBounds.every(Number.isFinite) ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return viewport;
  const [left, top, right, bottom] = carBounds;
  if (right <= left || bottom <= top) return viewport;

  let pane, largest = 0;
  for (const region of hitRegions) {
    if (!Array.isArray(region) || region.length !== 4 || !region.every(Number.isFinite)) continue;
    const [x1, y1, x2, y2] = region;
    if (x1 < 0 || y1 < 0 || x2 > width || y2 > height) continue;
    const x = Math.max(viewport.x, left + Math.ceil(x1 * (right - left) / width));
    const y = Math.max(viewport.y, top + Math.ceil(y1 * (bottom - top) / height));
    const endX = Math.min(viewport.x + viewport.width, left + Math.ceil(x2 * (right - left) / width));
    const endY = Math.min(viewport.y + viewport.height, top + Math.ceil(y2 * (bottom - top) / height));
    const w = endX - x, h = endY - y;
    if (w > 0 && h > 0 && w * h > largest) {
      pane = { x, y, width: w, height: h };
      largest = w * h;
    }
  }
  return pane ? { ...viewport, implicitOriginViewport: pane } : viewport;
}

function projectionFacts(facts, device, { live, nativeFacts, resources, audio, orientation, volume, hasBackend, keyboard, alerts, metro, lifecycle, touch }) {
  return Object.freeze({ ...projectionDeviceFacts(facts, device), operations: Object.freeze({
    ...facts.operations,
    ...(live && !touch && touchHelperFacts),
    ...(live && { ...phoneFacts, ...nativeFacts, screenRecordingStart: available }),
    ...resources,
    ...audio,
    ...orientation,
    ...volume,
    ...(live && hasBackend && { appState: available, triggerAppEvent: available }),
    screenRecordingReattach: available,
    screenRecordingCleanup: available,
    ...(live && keyboard && keyboardFacts),
    ...(live && alerts && alertFacts),
    ...(live && metro && metroFacts),
    ...(live && lifecycle && pairLifecycleFacts),
  }) });
}

function sameOwner(left, right) {
  return left.kind === right.kind && left.provider === right.provider && left.instance === right.instance;
}

function nativeDevice(serial, name) {
  return {
    id: serial, name: name + " " + serial, platform: "android", target: "mobile",
    kind: serial.startsWith("emulator-") ? "emulator" : "device",
  };
}

async function withNativeBinding(android, request, device, action) {
  const binding = await android.bind({ ...request, device, intent: { kind: "ordinary" } });
  try {
    return await action(binding);
  } finally {
    await binding[Symbol.asyncDispose]();
  }
}

async function setPhoneLocation(androidTools, phoneDevice, input, scope, pluginHost) {
  if (phoneDevice.kind !== "emulator") {
    throw pluginHost.createError("UNSUPPORTED_OPERATION", "Location coordinates require a verified Android emulator pair.", {
      dispatched: "no",
    });
  }
  const { latitude, longitude } = input.options ?? {};
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw pluginHost.createError("INVALID_ARGS", "Provide valid latitude and longitude coordinates.");
  }
  const result = await androidTools.runAdb(phoneDevice, ["emu", "geo", "fix", String(longitude), String(latitude)],
    { allowFailure: true, timeoutMs: 15000 }, scope.signal);
  // ADB can exit successfully when the emulator console rejects a command.
  if (result.exitCode !== 0 || /^KO\b/m.test(`${result.stdout}\n${result.stderr}`) || !/^OK\r?$/m.test(result.stdout)) {
    throw pluginHost.createError("COMMAND_FAILED", "The projecting emulator did not accept the location change.", {
      hint: `Check that adb emu commands can authenticate to ${phoneDevice.id}.`,
    });
  }
  return { latitude, longitude };
}

function phoneOperations(android, androidTools, request, phoneDevice, nativeFacts, pluginHost, upstream) {
  const bindNative = (action) => withNativeBinding(android, request, phoneDevice, action);
  async function resolveSettingPackage(target, setting) {
    const { signal } = request.scope;
    signal.throwIfAborted();
    const userId = setting === "permission" ? await upstream.readAndroidCurrentUserId(phoneDevice) : undefined;
    if (setting === "permission" && userId === undefined) {
      throw pluginHost.createError("COMMAND_FAILED", "Could not determine the current Android user. No permission was changed.", {
        deviceId: phoneDevice.id, dispatched: "no",
        hint: "Check the projecting emulator is ready and reports its current Android user, then retry.",
      });
    }
    signal.throwIfAborted();
    const resolved = await upstream.resolveAndroidApp(phoneDevice, target, { installedOnly: true, userId });
    signal.throwIfAborted();
    if (resolved.type !== "package") {
      throw pluginHost.createError("INVALID_ARGS", `settings ${setting} requires an installed Android package.`, {
        reason: "setting_app_not_package", dispatched: "no",
      });
    }
    return resolved.value;
  }
  const operations = bindPhoneOperations({ facts: nativeFacts, bindNative, createError: pluginHost.createError,
    resolvePackage: resolveSettingPackage,
    setLocation: (input) => setPhoneLocation(androidTools, phoneDevice, input, request.scope, pluginHost) });
  const sendTelephonyEvent = operations.sendTelephonyEvent;
  if (sendTelephonyEvent && androidTools) {
    operations.sendTelephonyEvent = async (input) => {
      const service = input.action === "sms" ? "isms" : "phone";
      const adb = upstream.deviceShellArgv("adb", "shell", ["service", "check", service]);
      const result = await androidTools.runAdb(phoneDevice, adb,
        { allowFailure: true, timeoutMs: 4000 }, request.scope.signal);
      const status = result.stdout.trim();
      if (result.exitCode === 0 && status === `Service ${service}: not found`) {
        throw pluginHost.createError("UNSUPPORTED_OPERATION", "The projecting emulator's Android telephony service is unavailable.", {
          deviceId: phoneDevice.id, reason: "headunit_telephony_service_unavailable", dispatched: "no",
        });
      }
      if (result.exitCode !== 0 || status !== `Service ${service}: found`) {
        throw pluginHost.createError("COMMAND_FAILED", "Could not check the projecting emulator's Android telephony service.", {
          deviceId: phoneDevice.id, dispatched: "no",
        });
      }
      return await sendTelephonyEvent(input);
    };
  }
  return {
    ...Object.fromEntries(phoneActions.map((op) => [op, (input) =>
      bindNative(({ operations }) =>
        operations[op](op === "listApps" ? { ...input, device: phoneDevice } : input)),
    ])),
    ...operations,
    ...(nativeFacts.sendPushNotification.available && {
      sendPushNotification: bindPhonePush({ bindNative, createError: pluginHost.createError }),
    }),
  };
}

function recordingOperations(android, deviceIdentity, request, receiver, owner, live) {
  const receiverDevice = nativeDevice(receiver, "Open Headunit receiver");
  const projection = deviceIdentity(request.device);
  const recover = (operation, { envelope }) => withNativeBinding(android, request, receiverDevice, (binding) =>
    binding.operations[operation]({ envelope: { ...envelope, device: deviceIdentity(binding.device), owner: binding.owner } }));
  return {
    ...(live && {
      screenRecordingStart: (input) => withNativeBinding(android, request, receiverDevice, async ({ operations }) => {
        const started = await operations.screenRecordingStart(input);
        return { ...started, envelope: { ...started.envelope, device: projection, owner } };
      }),
    }),
    screenRecordingReattach: (input) => recover("screenRecordingReattach", input),
    screenRecordingCleanup: (input) => recover("screenRecordingCleanup", input),
  };
}

function isProjectedAppLabel(target) {
  return typeof target === "string" && Boolean(target.trim()) && !packageTarget.test(target) &&
    !linkTarget.test(target) && !projectionAliases.has(target);
}

function resolveProjectedOpenApp(call, target, { activity, launchArgs } = {}) {
  return call("resolveApp", { target, arguments: launchArgs, ...(activity !== undefined && { activity }) });
}

function bindProjectionOpen(open, call, clearAppState, createError) {
  return async (input) => {
    const [target, url] = input.positionals;
    const execution = input.execution ?? {};
    if (!target || input.positionals.length > 2 || execution.launchConsole) {
      return open(input);
    }
    const { activity, launchArgs } = execution;
    const isUrl = linkTarget.test(target);
    const appBoundUrl = url !== undefined;
    if (activity !== undefined && (isUrl || appBoundUrl)) {
      throw createError("INVALID_ARGS", "Activity override is not supported when opening a deep link URL.", {
        dispatched: "no",
      });
    }
    const currentApp = input.appBundleId === projectionShell ? undefined : input.appBundleId;
    if (execution.clearAppState && isUrl) return open(input);
    if (appBoundUrl || isUrl) {
      if (isUrl && appBoundUrl) return open(input);
      const result = await call("deepLink", {
        target: appBoundUrl ? target : currentApp, url: url ?? target, arguments: launchArgs,
        ...(appBoundUrl && input.relaunch === true && { relaunch: true }),
      });
      return { appBundleId: result.package, timing: {} };
    }

    const resolveLabel = isProjectedAppLabel(target);
    let app = target;
    let packageName = target.split("/", 1)[0];
    if (execution.clearAppState && !clearAppState) {
      throw createError("UNSUPPORTED_OPERATION", "The projecting phone cannot clear app state.");
    }
    if (resolveLabel || execution.clearAppState) {
      const resolved = await resolveProjectedOpenApp(call, app, execution);
      packageName = resolved.package;
      app = resolved.component;
    }
    if (execution.clearAppState) {
      await clearAppState({ setting: "clear-app-state", state: "clear", appBundleId: packageName });
    }

    let result;
    const exactComponent = packageTarget.test(app) && app.includes("/");
    if (resolveLabel || exactComponent || launchArgs?.length || input.relaunch && packageTarget.test(app) ||
        activity !== undefined || execution.clearAppState) {
      const relaunch = input.relaunch && !execution.clearAppState;
      const opened = launchArgs?.length || activity !== undefined
        ? await call("openWithExtras", { target: app, arguments: launchArgs ?? [], relaunch,
          ...(activity !== undefined && { activity }),
        })
        : await call(relaunch ? "relaunch" : "open", { target: app });
      result = { appBundleId: resolveLabel ? packageName : opened.package ?? packageName, timing: {} };
    } else {
      result = await open({ ...input, runtimeLaunchUrl: undefined });
    }
    if (input.runtimeLaunchUrl) {
      const started = Date.now();
      const target = result.appBundleId === projectionShell ? undefined : result.appBundleId ?? currentApp;
      await call("deepLink", { target, url: input.runtimeLaunchUrl });
      return { ...result, timing: { ...result.timing, launchUrlDurationMs: Date.now() - started } };
    }
    return result;
  };
}

function bindProjectionClose(close, call, bindPhone, createError) {
  return async (input) => {
    if (input.mode !== "kill") return close(input);
    const [target] = input.positionals;
    if (!target) throw createError("INVALID_ARGS", "Kill requires a projected app target.", { dispatched: "no" });
    const app = await call("resolveApp", { target });
    if (app.foreground) {
      throw createError("COMMAND_FAILED", `Cannot kill foreground app ${app.package}.`, {
        reason: "android-kill-requires-background-app",
        hint: "Background the projected app before killApp.",
        dispatched: "no",
      });
    }
    return await bindPhone((binding) => binding.operations.closeApplication({
      ...input, positionals: [app.package], appBundleId: app.package,
    }));
  };
}

export async function directRuntime(webDriver, pluginHost, upstream, call, emulatorIds = new Set(), transports = new Map(), configuredPair) {
  const runtime = await upstream.createCloudWebDriverRuntime({ ...webDriver, clientVersion: pluginHost.clientVersion });
  runtime.cloudArtifacts = {
    ...runtime.cloudArtifacts,
    daemonSessionArtifacts: (provider) => provider === webDriver.provider,
  };
  runtime.deviceInventoryProvider = projectionInventory(runtime, emulatorIds);
  if (configuredPair) {
    const ownsDevice = runtime.ownsDevice.bind(runtime);
    runtime.ownsDevice = (device) => configuredPair.ownsDevice(device) || ownsDevice(device);
    runtime.unleasedDeviceInventoryProvider = configuredPair.discover;
  }
  const baseModule = runtime.platformRuntimeModule;
  const { owner } = baseModule;
  const managedInteraction = (controller) => Boolean(call && (pluginHost.env?.HEADUNIT_FRIDA_SESSION || controller?.managed));
  return {
    runtime,
    platformModule: {
      owner,
      async loadRuntime(host) {
        const base = await baseModule.loadRuntime(host);
        const androidHost = host.processes && host.processTransports ? withPortableAppLogMarkers(host) : host;
        const android = upstream.createAndroidPlatformRuntime(androidHost);
        const windowsAudio = process.platform === "win32" && usesLocalAdb(host.hostEnvironment?.env) &&
          typeof upstream.createHostAudioProbeCaptureOperations === "function";
        const runAdbShell = (device, words, options, signal) =>
          host.androidTools.runAdb(device, upstream.deviceShellArgv("adb", "shell", words), options, signal);
        const projectingPhone = (serial, device, live) => ({ ...nativeDevice(serial, "Projecting Android phone"),
          kind: (live ? emulatorIds.has(device.id) : device.kind === "emulator") ? "emulator" : "device", booted: true });
        const selectedReceiver = (serial, device, live) => ({ ...nativeDevice(serial, "Open Headunit receiver"),
          kind: (live ? emulatorIds.has(device.id) : device.kind === "emulator") ? "emulator" : "device", booted: true });
        async function configuredFacts(device) {
          const facts = projectionDeviceFacts(await base.inspectFacts(webDriverDevice(device)), device);
          return Object.freeze({ ...facts, operations: Object.freeze({ ...facts.operations, ...configuredPair.operations }) });
        }
        return Object.freeze({
          ...base,
          ownsDevice: (device) => configuredPair?.ownsDevice(device) || Boolean(projectionPair(device)) || base.ownsDevice(device),
          async inspectFacts(device) {
            if (configuredPair?.ownsDevice(device)) return configuredFacts(device);
            const pair = projectionPair(device);
            if (!pair) return base.inspectFacts(device);
            const driverDevice = webDriverDevice(device);
            const facts = await base.inspectFacts(driverDevice);
            const live = Boolean(runtime.getInteractor(driverDevice));
            const [native, receiver] = await Promise.all([
              android.inspectFacts(projectingPhone(pair[0], device, live)),
              android.inspectFacts(selectedReceiver(pair[1], device, live)),
            ]);
            const controller = transports.get(device.id);
            const keyboard = managedInteraction(controller);
            return projectionFacts(facts, device, { live, nativeFacts: phoneOperationFacts(native),
              resources: appResourceFacts(native, live),
              audio: receiverAudioFacts(receiver, live, windowsAudio && Boolean(controller?.audioReceiver)),
              orientation: receiverOrientationFacts(receiver, live && Boolean(call && host.androidTools)),
              volume: receiverVolumeFacts(receiver, live),
              hasBackend: Boolean(call), keyboard, alerts: keyboard && Boolean(upstream.runTreeAlertAction),
              metro: host.androidApplications && host.androidTools && controller?.ports,
              lifecycle: controller?.lifecycle, touch: controller?.touch,
            });
          },
          async bind(request) {
            const { device, scope } = request;
            if (configuredPair?.ownsDevice(device) && request.intent.kind === "ordinary") {
              return Object.freeze({ device, owner, facts: await configuredFacts(device),
                operations: configuredPair.bind({ host, scope }), [Symbol.asyncDispose]: async () => {} });
            }
            const pair = projectionPair(device);
            if (!pair) return base.bind(request);
            const driverDevice = webDriverDevice(device);
            const driverRequest = { ...request, device: driverDevice };
            const live = Boolean(runtime.getInteractor(driverDevice));
            const recovery = request.intent.kind === "exact-owner" && sameOwner(request.intent.owner, owner);
            if (!live && !recovery) return base.bind(driverRequest);
            const binding = live ? await base.bind(driverRequest) : undefined;
            const facts = binding?.facts ?? await base.inspectFacts(driverDevice);
            const phoneDevice = projectingPhone(pair[0], device, live);
            const receiverDevice = selectedReceiver(pair[1], device, live);
            const [native, receiver] = await Promise.all([
              android.inspectFacts(phoneDevice), android.inspectFacts(receiverDevice),
            ]);
            const nativeFacts = phoneOperationFacts(native);
            const resourceFacts = appResourceFacts(native, live);
            const orientation = receiverOrientationFacts(receiver, live && Boolean(call && host.androidTools));
            const volume = receiverVolumeFacts(receiver, live);
            const controller = transports.get(device.id);
            const audioReceiver = controller?.audioReceiver;
            const emulatorCapture = windowsAudio && receiverDevice.kind === "emulator" &&
              (audioReceiver || recovery) ? createEmulatorAudioCaptureOperations({
                serial: receiverDevice.id, avdName: audioReceiver?.avdName, device, owner,
                createHostAudioProbeCaptureOperations: upstream.createHostAudioProbeCaptureOperations,
                resolveManagedProcessIdentity: upstream.resolveManagedProcessIdentity,
                inspectManagedProcess: upstream.inspectManagedProcess,
                terminateManagedProcessSet: upstream.terminateManagedProcessSet,
              }) : undefined;
            const audioFacts = receiverAudioFacts(receiver, live && (!emulatorCapture || Boolean(audioReceiver)),
              Boolean(emulatorCapture));
            const touch = controller?.touch;
            const keyboard = managedInteraction(controller);
            const alerts = keyboard && Boolean(upstream.runTreeAlertAction);
            const sessionCall = controller?.call ?? call;
            const metro = host.androidApplications && host.androidTools && controller?.ports;
            const lifecycle = controller?.lifecycle;
            const pairLifecycle = lifecycle && bindPairLifecycle(lifecycle, { host, device, scope, createError: pluginHost.createError });
            async function callProjection(op, parameters, signal = scope.signal) {
              try {
                const { ok: _ok, ...result } = await sessionCall({ op, serial: pair[0], ...parameters }, signal);
                return result;
              } catch (error) {
                scope.signal.throwIfAborted();
                throw pluginHost.createError("COMMAND_FAILED", error instanceof Error ? error.message : String(error));
              }
            }
            const keyboardOperations = keyboard ? Object.fromEntries(keyboardActions.map((op) => [op, () => callProjection(op)])) : {};
            const alertOperations = alerts ? Object.fromEntries(Object.entries(alertActions).map(([op, action]) => [op,
              (input) => upstream.runTreeAlertAction(action, {
                platform: "android", timeoutMs: input.timeoutMs, signal: scope.signal,
                capture: ({ signal }) => callProjection("alertObservation", undefined, signal),
                findCandidate: (observation) => observation,
                choose: (candidate) => candidate[action] ? { kind: "press", button: candidate[action] }
                  : action === "dismiss" ? { kind: "fallback", label: "Back", alert: candidate.alert } : null,
                press: (choice, { signal }) => callProjection("alertPress", choice.kind === "press"
                  ? { action, ref: choice.button.ref } : { action, fallback: true, alert: choice.alert }, signal),
              }),
            ])) : {};
            const phone = live && phoneOperations(android, host.androidTools, request, phoneDevice, nativeFacts, pluginHost, upstream);
            const open = binding?.operations.openApplication;
            const openApplication = open && call
              ? bindProjectionOpen(open, callProjection, phone?.setSetting, pluginHost.createError) : open;
            const close = binding?.operations.closeApplication;
            const closeApplication = close && call ? bindProjectionClose(close, callProjection,
              (action) => withNativeBinding(android, request, phoneDevice, action), pluginHost.createError) : close;
            return Object.freeze({
              device,
              owner,
              facts: projectionFacts(facts, device, { live, nativeFacts, resources: resourceFacts, audio: audioFacts, orientation, volume,
                hasBackend: Boolean(call), keyboard, alerts, metro, lifecycle, touch,
              }),
              operations: Object.freeze({
                ...(touch ? binding?.operations : Object.fromEntries(Object.entries(binding?.operations ?? {})
                  .filter(([operation]) => !Object.hasOwn(touchHelperFacts, operation)))),
                ...(live && {
                  ...(controller?.captureSnapshot && binding.operations.captureSnapshot && {
                    captureSnapshot: (input) => controller.captureSnapshot(input, scope.signal),
                  }),
                  ...(controller?.scrollDirection && binding.operations.scrollDirection && {
                    scrollDirection: (input) => controller.scrollDirection(input, scope.signal),
                  }),
                  ensureReady: async (input) => ({ ...(await binding.operations.ensureReady(input)), kind: device.kind }),
                  bootTarget: async (input) => ({ ...(await binding.operations.bootTarget(input)), kind: device.kind }),
                  ...phone,
                  ...bindReceiverVolumeOperations({ facts: volume,
                    bindNative: (action) => withNativeBinding(android, request, receiverDevice, action),
                    createError: pluginHost.createError,
                  }),
                  ...(call && {
                    appState: () => callProjection("appstate"),
                    gestureViewport: async () => projectedGestureViewport(await callProjection("layout")),
                    triggerAppEvent: async ({ eventUrl, options }) => {
                      const app = options?.appBundleId;
                      await callProjection("deepLink", { target: app === projectionShell ? undefined : app, url: eventUrl });
                    },
                  }),
                  ...keyboardOperations,
                  ...alertOperations,
                  ...(openApplication && { openApplication }),
                  ...(closeApplication && { closeApplication }),
                  ...(metro && projectedMetroOperations({
                    openApplication, applications: host.androidApplications, phone: phoneDevice,
                    leaseId: controller.leaseId,
                    reverse: (input) => metro.configure(input, scope.signal),
                    readCatalog: () => callProjection("appCatalog"),
                    resolveLabel: ({ positionals: [target], execution }) => isProjectedAppLabel(target)
                      ? resolveProjectedOpenApp(callProjection, target, execution) : undefined,
                    closeProjected: (target) => callProjection("close", { target }),
                    runAdbShell, signal: scope.signal, createError: pluginHost.createError,
                  })),
                  ...pairLifecycle,
                  // A retry can reach this binding after its receiver or phone has already stopped.
                  ...(lifecycle?.stopping && { closeApplication: async () => {}, clearRuntimeHints: async () => {} }),
                }),
                ...bindAppResourceOperations({ facts: resourceFacts,
                  bindNative: (action) => withNativeBinding(android, request, phoneDevice, action),
                  projection: upstream.deviceIdentity(device), owner, deviceIdentity: upstream.deviceIdentity,
                  createError: pluginHost.createError,
                }),
                ...bindReceiverAudioOperations({ facts: audioFacts,
                  bindNative: (action) => withNativeBinding(android, request, receiverDevice, action),
                  projection: upstream.deviceIdentity(device), owner, deviceIdentity: upstream.deviceIdentity,
                  createError: pluginHost.createError,
                  emulatorCapture, verifyEmulatorReceiver: audioReceiver && (() => audioReceiver.verify(scope.signal)),
                }),
                ...(live && call && host.androidTools && bindReceiverOrientationOperations({ facts: orientation,
                  bindNative: (action) => withNativeBinding(android, request, receiverDevice, action),
                  readLayout: (signal) => sessionCall({ op: "layout", serial: pair[0] }, signal),
                  updateLayout: controller?.updateLayout,
                  receiverDevice, phoneSerial: pair[0], scope, runAdbShell,
                  createError: pluginHost.createError,
                })),
                ...recordingOperations(android, upstream.deviceIdentity, request, pair[1], owner, live),
              }),
              [Symbol.asyncDispose]: async () => await binding?.[Symbol.asyncDispose](),
            });
          },
          async shutdown() {
            try { await base.shutdown(); } finally { await android.shutdown(); }
          },
        });
      },
    },
  };
}
