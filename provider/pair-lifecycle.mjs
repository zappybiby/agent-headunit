import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { ManagedProjectionCleanupError } from "./managed-projection.mjs";

const available = Object.freeze({ available: true });
export const pairLifecycleFacts = Object.freeze({
  ensureReady: available,
  bootTarget: available,
  bootTargetHeadless: available,
  shutdownTarget: available,
});

const stopTimeoutMs = 15000;
const pollMs = 250;
const transportIdPattern = /^[1-9]\d*$/;

function consolePort(serial) {
  if (typeof serial !== "string") return;
  const match = /^emulator-([1-9]\d{0,4})$/.exec(serial);
  if (match && Number(match[1]) <= 65535) return Number(match[1]);
}

export function supportsPairLifecycle(phone, receiver) {
  return phone !== receiver && Boolean(consolePort(phone) && consolePort(receiver));
}

export function usesLocalAdb(env) {
  const address = env?.ANDROID_ADB_SERVER_ADDRESS;
  const socket = env?.ADB_SERVER_SOCKET;
  return (!address || ["localhost", "127.0.0.1", "::1"].includes(address)) &&
    (!socket || /^(?:local(?:abstract|filesystem|reserved)?:|tcp:(?:(?:localhost|127\.0\.0\.1|\[::1\]):)?\d+$)/.test(socket));
}

async function readTransports(commands, signal, createError) {
  const result = await commands.run({ executable: "adb", args: ["devices", "-l"], timeoutMs: 5000 }, signal);
  const [header, ...lines] = result.stdout.trim().split(/\r?\n/);
  if (result.exitCode !== 0 || header.trim() !== "List of devices attached") {
    throw createError("COMMAND_FAILED", "Could not confirm the Open Headunit emulator transports.");
  }
  const rows = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const [serial, state, ...fields] = line.trim().split(/\s+/);
    if (!state || rows.has(serial)) {
      throw createError("COMMAND_FAILED", "ADB returned an ambiguous emulator inventory.");
    }
    const id = fields.find((field) => field.startsWith("transport_id:"))?.slice("transport_id:".length);
    rows.set(serial, { state, id });
  }
  return rows;
}

function consoleStopped(serial, signal) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: consolePort(serial), signal });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => {
      if (signal.aborted) reject(signal.reason);
      else resolve(error.code === "ECONNREFUSED");
    });
    socket.setTimeout(700, () => { socket.destroy(); resolve(false); });
  });
}

function assertTransport(serial, row, expected, createError) {
  if (!row || !transportIdPattern.test(row.id ?? "") || (expected && row.id !== expected)) {
    throw createError("DEVICE_NOT_FOUND", `Cannot verify the owned ADB transport for ${serial}.`, { serial });
  }
}

export async function stopPinnedEmulator({ serial, transportId, host, signal, createError, assertOwned }) {
  assertOwned();
  const read = () => readTransports(host.commands, signal, createError);
  const connected = (await read()).get(serial);
  if (!connected && await consoleStopped(serial, signal)) return;
  assertTransport(serial, connected, transportId, createError);
  assertOwned();
  const result = await host.deviceShutdown.android.shutdownTarget({
    id: serial, name: serial, platform: "android", kind: "emulator", target: "mobile", booted: true,
  }, signal);
  const deadline = Date.now() + stopTimeoutMs;
  do {
    assertOwned();
    const current = (await read()).get(serial);
    if (current) assertTransport(serial, current, transportId, createError);
    else if (await consoleStopped(serial, signal)) return;
    if (!result.success) {
      throw createError("COMMAND_FAILED", `Could not stop the owned emulator ${serial}.`, {
        serial, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr,
      });
    }
    await sleep(pollMs, undefined, { signal });
  } while (Date.now() < deadline);
  throw createError("COMMAND_FAILED", `The owned emulator ${serial} did not stop in time.`, { serial });
}

export function createPairLifecycle({ phone, receiver, phoneAvd, leaseId, ports, owns, checkProjection, transports, beforeStop }) {
  if (!supportsPairLifecycle(phone, receiver)) throw new Error("Open Headunit lifecycle requires two local emulator serials.");
  const members = [receiver, phone];
  const stopped = new Set();
  let stopping = false;
  let portsReleased = false;
  let serviceExited = false;
  let pinned;
  if (transports !== undefined) {
    pinned = new Map(members.map((serial) => [serial, transports[serial]]));
    if ([...pinned.values()].some((id) => typeof id !== "string" || !transportIdPattern.test(id)) ||
        new Set(pinned.values()).size !== members.length) {
      throw new Error("Open Headunit lifecycle needs both ADB transport IDs.");
    }
  }
  let pending = Promise.resolve();

  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  function bind({ host, device, scope, createError }) {
    const { signal } = scope;
    const read = (probeSignal = signal) => readTransports(host.commands, probeSignal, createError);

    function assertOwned() {
      signal.throwIfAborted();
      scope.checkDeadline?.();
      if (!owns()) throw createError("DEVICE_IN_USE", "This lease no longer owns the Open Headunit pair.");
      if (!usesLocalAdb(host.hostEnvironment?.env)) {
        throw createError("UNSUPPORTED_OPERATION", "Open Headunit pair lifecycle requires a local ADB server.");
      }
    }

    async function verifyProjection(probeSignal = signal) {
      const rows = await read(probeSignal);
      const observed = new Map();
      for (const serial of members) {
        const row = rows.get(serial);
        assertTransport(serial, row, pinned?.get(serial), createError);
        if (row.state !== "device") {
          throw createError("DEVICE_NOT_FOUND", `The owned emulator ${serial} is ${row.state}.`, { serial });
        }
        observed.set(serial, row.id);
      }
      if (new Set(observed.values()).size !== members.length) {
        throw createError("COMMAND_FAILED", "ADB returned indistinguishable transports for the emulator pair.");
      }
      const scene = await checkProjection(probeSignal);
      if (scene.serial !== phone || scene.receiver !== receiver || scene.emulators !== true || !scene.displays?.length) {
        throw createError("DEVICE_NOT_FOUND", "The owned phone and receiver do not have an active projection.");
      }
      const refreshed = await read(probeSignal);
      for (const serial of members) assertTransport(serial, refreshed.get(serial), observed.get(serial), createError);
      assertOwned();
      pinned ??= observed;
    }

    async function ready(input = {}) {
      return serialize(async () => {
        assertOwned();
        if (stopping) throw createError("COMMAND_FAILED", "Open Headunit shutdown is already in progress.");
        if ((input.serial && ![phone, phoneAvd, device.id].includes(input.serial)) ||
            (input.androidSerialAllowlist && members.some((serial) => !input.androidSerialAllowlist.includes(serial)))) {
          throw createError("DEVICE_NOT_FOUND", "The requested Android selector excludes the Open Headunit pair.");
        }
        const remaining = (input.deadlineAtMs ?? (Date.now() + 120000)) - Date.now();
        const timedOut = () => createError("COMMAND_FAILED", "The Open Headunit pair did not become ready in time.", {
          reason: "boot_timeout",
        });
        if (remaining <= 0) throw timedOut();
        const deadline = AbortSignal.timeout(Math.min(remaining, 2147483647));
        const probeSignal = AbortSignal.any([signal, deadline]);
        try {
          const devices = await host.deviceReadiness.androidEmulator.discover({
            platform: "android", androidAvdSelection: "running-only", androidSerialAllowlist: members,
          }, probeSignal);
          for (const serial of members) {
            if (!devices.some((item) => item.id === serial && item.kind === "emulator" && item.booted === true)) {
              throw createError("DEVICE_NOT_FOUND", `The owned emulator ${serial} has not finished booting.`, { serial });
            }
          }
          await verifyProjection(probeSignal);
          probeSignal.throwIfAborted();
          return { ...device, booted: true };
        } catch (error) {
          signal.throwIfAborted();
          throw deadline.aborted ? timedOut() : error;
        }
      });
    }

    async function stop(serial) {
      if (stopped.has(serial)) return;
      await stopPinnedEmulator({ serial, transportId: pinned.get(serial), host, signal, createError, assertOwned });
      stopped.add(serial);
    }

    return {
      ensureReady: ready,
      bootTarget: ready,
      bootTargetHeadless: ready,
      shutdownTarget: ({ releaseLease }) => serialize(async () => {
        assertOwned();
        if (!stopping) {
          await verifyProjection();
          assertOwned();
          stopping = true;
        }
        if (!portsReleased) {
          await ports?.cleanup();
          portsReleased = true;
        }
        if (!serviceExited) {
          assertOwned();
          try {
            await beforeStop?.();
            serviceExited = true;
          } catch (error) {
            // A departed launcher cannot retry its cleanup. A later request can still stop the pinned pair.
            serviceExited = error instanceof ManagedProjectionCleanupError;
            throw error;
          }
        }
        for (const serial of members) await stop(serial);
        assertOwned();
        return releaseLease(leaseId);
      }),
    };
  }

  return Object.freeze({
    get stopping() { return stopping; },
    get stopped() { return stopped.size === members.length; },
    bind,
  });
}

export function bindPairLifecycle(lifecycle, context) {
  return lifecycle.bind(context);
}
