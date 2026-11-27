import path from "node:path";
import { rpcClient, sessionRpcClient } from "./rpc.mjs";
import { startDriver } from "./driver.mjs";
import { directRuntime, projectionId } from "./provider-runtime.mjs";
import { findUpstreamRuntimeRoot, loadUpstreamRuntime } from "./upstream-runtime.mjs";
import { claimProjectionPair } from "./pair-claim.mjs";
import { metroPorts } from "./metro-runtime.mjs";
import { createPairLifecycle, supportsPairLifecycle } from "./pair-lifecycle.mjs";
import { startManagedProjection } from "./managed-projection.mjs";
import { projectedTouchHelper } from "./projected-touch.mjs";
import { bindProjectedSnapshot } from "./projected-snapshot.mjs";
import { bindProjectedScroll } from "./projected-scroll.mjs";
import { contactSheet } from "./cli/contact-sheet.mjs";
import { configuredPair } from "./configured-pair.mjs";

const provider = "headunit";
const service = "Open Headunit";
const upstreamRoot = await findUpstreamRuntimeRoot();
const cloudFields = [
  "providerApp", "providerOsVersion", "providerDeviceType", "providerProject", "providerBuild",
  "providerSessionName", "providerDeviceOrientation", "providerGeoLocation", "providerTimezone",
  "providerAppiumVersion", "providerLanguage", "providerLocale", "providerNetworkProfile",
  "providerCustomNetwork", "providerNoResignApp", "providerNetworkLogs", "providerNetworkHosts",
  "awsProjectArn", "awsDeviceArn", "awsAppArn", "awsRegion", "awsInteractionMode",
];
const profileFields = {
  provider, label: service, fields: {
    ...Object.fromEntries(cloudFields.map((key) => [key, "refused"])),
    // Deferred allocation carries the first open target here. The driver activates it after allocation.
    ...(upstreamRoot && { providerApp: "consumed" }),
  },
};
const unsupported = [
  "install", "orientation", "volumeUp", "volumeDown", "power", "mute", "sleep",
  "wake",
  "clipboard.read", "clipboard.write", "fill", "type", "keyboard", "tvRemote", "settings", "alert", "logs", "record", "artifacts",
  "portReverse", "nativeSnapshotBackend",
];
const touchHelperOperations = ["doubleTap", "pinch", "rotateGesture", "transformGesture", "tapGesture"];

function requestedSerial(flags, options) {
  return flags.serial ?? flags.device ?? options.serial;
}

function managedOptions(options, host) {
  const { phoneAvd, receiverAvd, fridaServer, audio, python, backend } = options;
  if ([phoneAvd, receiverAvd, fridaServer, audio].every((value) => value === undefined)) return;
  const validAvd = (value) => typeof value === "string" && /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(value);
  if (!validAvd(phoneAvd) || !validAvd(receiverAvd) || phoneAvd === receiverAvd ||
      typeof fridaServer !== "string" || !path.isAbsolute(fridaServer) || (audio !== undefined && typeof audio !== "boolean")) {
    throw host.createError("INVALID_ARGS", "Configure two distinct AVD names and an absolute Frida server path.");
  }
  return { phoneAvd, receiverAvd, fridaServer, audio, python: python ?? host.env?.HEADUNIT_PYTHON, backend };
}

function validateConnection(flags, host, options) {
  if (flags.platform && flags.platform !== "android") {
    throw host.createError("INVALID_ARGS", "Open Headunit requires Android.");
  }
  if (flags.providerApp) {
    throw host.createError("INVALID_ARGS", "Select a projected app with agent-device open after connecting.");
  }
  const config = managedOptions(options, host);
  const selected = requestedSerial(flags, options);
  if (config && selected && selected !== config.phoneAvd) {
    throw host.createError("INVALID_ARGS", `Choose the configured phone AVD ${config.phoneAvd}.`);
  }
  return config;
}

export function managedPreparation({ deadline, signal: parent } = {}, host) {
  const expiry = new AbortController();
  let phase = "claiming the configured emulator pair";
  function expire() {
    expiry.abort(host.createError("COMMAND_FAILED", `Open Headunit reached its allocation deadline while ${phase}.`));
  }
  const timer = Number.isFinite(deadline) ? setTimeout(expire, Math.max(0, deadline - Date.now())) : undefined;
  timer?.unref();
  const signal = parent ? AbortSignal.any([parent, expiry.signal]) : expiry.signal;
  return {
    signal,
    enter(next) {
      signal.throwIfAborted();
      if (Number.isFinite(deadline) && Date.now() >= deadline) {
        expire();
        signal.throwIfAborted();
      }
      phase = next;
    },
    finish() { clearTimeout(timer); },
  };
}

export default function headunit(options = {}) {
  return {
    apiVersion: 2, provider, credentials: { variables: [] },
    contactSheet: (input) => contactSheet({ ...input, python: options.python }),
    connection: {
      capabilities: {
        leaseKind: "direct-device-provider", requiresAppAttachment: false, requiresRemoteDaemon: false,
        supportsArtifacts: false, supportsDeferredAppSelection: Boolean(upstreamRoot),
        supportsDirectPortReverse: Boolean(upstreamRoot),
        usesCloudWebDriverLease: true, holdsCloudDevice: false, forgetsEndedConnectionLease: true,
      },
      resolve({ flags, host }) {
        const config = validateConnection(flags, host, options);
        const serial = requestedSerial(flags, options) ?? config?.phoneAvd;
        return { profile: { leaseProvider: provider, platform: "android", ...(serial && { device: serial }) } };
      },
      async verify({ flags, host }) {
        const config = validateConnection(flags, host, options);
        if (config) return {
          provider, service, verificationMessage: "The configured emulator pair starts when the lease is allocated.",
          device: { status: "configured", name: config.phoneAvd, platform: "android" },
          app: { status: "deferred", name: "Android Auto", reference: "com.google.android.projection.gearhead" },
        };
        const call = rpcClient(options, host);
        const scene = await call({ op: "layout", serial: requestedSerial(flags, options) });
        return {
          provider, service, verificationMessage: "Read the active Android Auto projection.",
          device: { status: "verified", name: scene.serial, platform: "android" },
          app: { status: "verified", name: "Android Auto", reference: "com.google.android.projection.gearhead" },
        };
      },
    },
    async setup(host) {
      const call = rpcClient(options, host);
      const held = new Set();
      const emulatorIds = new Set();
      const transports = new Map();
      const upstream = upstreamRoot && host.clientVersion === "0.21.43"
        ? await loadUpstreamRuntime(upstreamRoot, host) : undefined;
      const config = managedOptions(options, host);
      if (config && !upstream) {
        throw host.createError("UNSUPPORTED_OPERATION", "Starting a configured Open Headunit pair requires agent-device 0.21.43.");
      }
      let startingOrRunning = false;
      const legacyTouch = projectedTouchHelper(host.env.HEADUNIT_TOUCH_DEVICE_JAR, host.env.HEADUNIT_TOUCH_ROOT);
      const webDriver = {
        provider, platform: "android", deviceName: service, profileFields,
        // The lease creates its private listener and supplies the actual endpoint in prepareSession.
        endpoint: "http://127.0.0.1:0",
        supportsTextEntryDelay: true,
        requestPolicy: { retryAttempts: 0, timeoutMs: legacyTouch || config ? 100000 : 35000 },
        // Agent-device 0.21.43 uses this for cleanup. Preparation follows the lease deadline.
        ...(config && { providerCallbackTimeoutMs: 75000 }),
        capabilityOverrides: {
          ...Object.fromEntries(unsupported.filter((op) =>
            !(host.env.HEADUNIT_FRIDA_SESSION || config) || !["type", "fill"].includes(op))
            .map((op) => [op, "unsupported"])),
          ...Object.fromEntries(touchHelperOperations.map((op) => [op, legacyTouch || config ? "supported" : "unsupported"])),
          snapshot: { support: "supported", note: "Android Auto native views on the composed car display." },
        },
        async prepareSession({ base, req, lease }) {
          const requested = requestedSerial(req?.flags ?? {}, options);
          if (config) {
            if (requested && requested !== config.phoneAvd) {
              throw host.createError("INVALID_ARGS", `Choose the configured phone AVD ${config.phoneAvd}.`);
            }
            if (startingOrRunning) {
              throw host.createError("DEVICE_IN_USE", "Another Headunit lease is using the configured pair.");
            }
            startingOrRunning = true;
          }
          let managed, worker, release, releaseNames, deviceId;
          let members = [];
          const preparation = config && managedPreparation(req, host);
          const signal = preparation?.signal ?? req?.signal;
          async function stopBackend() {
            try { await worker?.close(); }
            finally { await managed?.close(); }
          }
          async function releasePair() {
            try { await stopBackend(); }
            finally {
              try {
                try { await release?.(); } finally { await releaseNames?.(); }
              }
              finally {
                for (const serial of members) held.delete(serial);
                if (deviceId) {
                  emulatorIds.delete(deviceId);
                  transports.delete(deviceId);
                }
                if (config) startingOrRunning = false;
              }
            }
          }
          try {
            if (config) {
              preparation.enter("claiming the configured emulator pair");
              releaseNames = await claimProjectionPair("avd:" + config.phoneAvd, "avd:" + config.receiverAvd,
                { upstreamRoot, signal });
              preparation.enter("starting the emulators and connecting Android Auto");
              managed = await startManagedProjection(config, { signal, deadline: req?.deadline });
            }
            preparation?.enter("checking the active projection");
            const sessionEnv = managed && {
              HEADUNIT_FRIDA_SESSION: managed.fridaSession,
              HEADUNIT_RECEIVER_SERIAL: managed.receiver,
              ANDROID_SERIAL: managed.phone,
            };
            if (managed || host.env.HEADUNIT_FRIDA_SESSION) worker = sessionRpcClient(options, host, sessionEnv);
            const sessionCall = worker ?? call;
            const scene = await sessionCall({ op: "layout", serial: managed?.phone ?? requested,
              ...(upstream && { pinTransports: true }),
            }, signal);
            preparation?.enter("claiming the active emulator transports");
            if (!scene.serial || !scene.receiver || !scene.viewport || !scene.displays?.length ||
                managed && (scene.serial !== managed.phone || scene.receiver !== managed.receiver)) {
              throw new Error("Headunit backend returned no visible projection for the selected pair.");
            }
            if (!managed && legacyTouch && scene.serial !== host.env.ANDROID_SERIAL) {
              throw new Error("The projected touch helper belongs to another phone.");
            }
            const selected = [scene.serial, scene.receiver];
            if (selected.some((serial) => held.has(serial))) {
              throw host.createError("DEVICE_IN_USE", "Another Headunit lease is using this phone or receiver.");
            }
            members = selected;
            for (const serial of members) held.add(serial);
            deviceId = projectionId(...members);
            if (upstream) {
              if (scene.avds) {
                const [phoneAvd, receiverAvd] = members.map((serial) => scene.avds[serial]);
                if (managed && (phoneAvd !== config.phoneAvd || receiverAvd !== config.receiverAvd)) {
                  throw new Error("The selected AVD names changed while starting Open Headunit.");
                }
                releaseNames ??= await claimProjectionPair("avd:" + phoneAvd, "avd:" + receiverAvd,
                  { upstreamRoot, signal });
              }
              release = await claimProjectionPair(scene.serial, scene.receiver, { upstreamRoot, signal });
            }
            const leaseId = lease?.leaseId;
            if (upstream && !leaseId) throw new Error("Open Headunit did not receive a lease identity.");
            const ports = upstream ? metroPorts(sessionCall, scene.serial, leaseId, {
              transportId: scene.transports?.[scene.serial], assertHeld: release.assertHeld,
            }) : undefined;
            const touch = managed ? managed.touch : legacyTouch;
            const controller = { ports, leaseId, call: sessionCall, managed, touch, releasing: false };
            if (upstream && scene.emulators && scene.avds?.[scene.receiver] && scene.transports?.[scene.receiver]) {
              controller.audioReceiver = {
                avdName: scene.avds[scene.receiver],
                async verify(signal) {
                  release.assertHeld();
                  const current = await sessionCall({ op: "layout", serial: scene.serial, pinTransports: true }, signal);
                  release.assertHeld();
                  if (controller.releasing || current.serial !== scene.serial || current.receiver !== scene.receiver ||
                      current.transports?.[scene.serial] !== scene.transports[scene.serial] ||
                      current.transports?.[scene.receiver] !== scene.transports[scene.receiver] ||
                      current.avds?.[scene.receiver] !== scene.avds[scene.receiver]) {
                    throw host.createError("DEVICE_NOT_FOUND", "The Open Headunit receiver changed before audio capture.");
                  }
                },
              };
            }
            if (ports && scene.emulators && scene.transports && supportsPairLifecycle(scene.serial, scene.receiver)) {
              controller.lifecycle = createPairLifecycle({ phone: scene.serial, receiver: scene.receiver,
                phoneAvd: config?.phoneAvd, leaseId, ports, transports: scene.transports,
                beforeStop: managed && stopBackend,
                owns: () => {
                  if (controller.releasing || transports.get(deviceId) !== controller) return false;
                  release.assertHeld();
                  releaseNames?.assertHeld();
                  return true;
                },
                checkProjection: (signal) => sessionCall({ op: "layout", serial: scene.serial }, signal),
              });
            }
            preparation?.enter("starting the projection driver");
            const driver = await startDriver(scene, sessionCall, touch, managed?.adopt);
            controller.updateLayout = driver.updateLayout;
            if (upstream) {
              controller.captureSnapshot = bindProjectedSnapshot(driver.readSnapshotSource, upstream);
              controller.scrollDirection = bindProjectedScroll(driver.readScrollScene, driver.performScroll, upstream, host.createError);
            }
            if (ports) transports.set(deviceId, controller);
            if (scene.emulators === true) emulatorIds.add(deviceId);
            return {
              ...base, endpoint: driver.endpoint, headers: driver.headers,
              deviceName: config?.phoneAvd ?? service + " " + scene.serial,
              deviceId, providerData: { serial: scene.serial, receiver: scene.receiver },
              async cleanup() {
                if (controller.lifecycle?.stopping && !controller.lifecycle.stopped) {
                  throw host.createError("DEVICE_IN_USE", "Finish the Open Headunit pair shutdown before releasing its lease.");
                }
                controller.releasing = true;
                controller.tearingDown = true;
                try { await driver.cleanup(); }
                finally { try { await ports?.cleanup(); } finally { await releasePair(); } }
              },
            };
          } catch (error) { await releasePair(); throw error; }
          finally { preparation?.finish(); }
        },
      };
      if (!upstream) return { webDriver };
      const configured = configuredPair(config, { call, upstreamRoot, createError: host.createError, env: host.env });
      const result = await directRuntime(webDriver, host, upstream, call, emulatorIds, transports, configured);
      const leaseLifecycle = result.runtime.leaseLifecycle;
      result.runtime.leaseLifecycle = { ...leaseLifecycle, async release(lease, context) {
        const controller = [...transports.values()].find((entry) => entry.leaseId === lease.leaseId);
        if (controller?.lifecycle?.stopping && !controller.lifecycle.stopped) {
          throw host.createError("DEVICE_IN_USE", "Finish the Open Headunit pair shutdown before disconnecting.");
        }
        if (!controller) return await leaseLifecycle.release(lease, context);
        if (controller.releasePending) return await controller.releasePending;
        controller.releasing = true;
        controller.releasePending = Promise.resolve().then(() => leaseLifecycle.release(lease, context));
        try { return await controller.releasePending; }
        finally {
          controller.releasePending = undefined;
          if (!controller.tearingDown) controller.releasing = false;
        }
      } };
      result.runtime.appCatalog = async ({ platform }, signal) => {
        if (platform !== "android") throw host.createError("INVALID_ARGS", "Open Headunit requires Android.");
        const selector = config ? { phoneAvd: config.phoneAvd } : { serial: options.serial };
        let apps;
        try {
          ({ apps } = await call({ op: "appCatalog", ...selector }, signal));
        } catch (error) {
          signal?.throwIfAborted();
          throw host.createError("COMMAND_FAILED", error instanceof Error ? error.message : String(error));
        }
        return [...new Set(apps.filter(({ category, profile }) => category !== "OEM" && profile === "PERSONAL")
          .map(({ component }) => component))];
      };
      return result;
    },
  };
}
