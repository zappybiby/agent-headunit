import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const packageName = /^[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+$/;
const gearhead = "com.google.android.projection.gearhead";
const available = Object.freeze({ available: true });
const transportIdPattern = /^[1-9]\d*$/;
const journalFilePattern = /^[a-f0-9]{32}\.json(?:\.pending)?$/;
const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

export const metroFacts = Object.freeze({
  applyRuntimeHints: available,
  clearRuntimeHints: available,
  configureProviderPortReverse: available,
});

export function metroOperations(openApplication, applications, phone, reverse, createError) {
  async function apply(operation, input) {
    if (!input.appId) return;
    const appId = input.appId.split("/", 1)[0];
    if (!packageName.test(appId) || appId === gearhead) {
      throw createError("INVALID_ARGS", "Select the projected app's Android package for Metro.");
    }
    await applications[operation](phone, { ...input, appId });
  }
  return {
    applyRuntimeHints: (input) => apply("applyRuntimeHints", input),
    clearRuntimeHints: (input) => apply("clearRuntimeHints", input),
    async openApplication(input) {
      const started = Date.now();
      if (input.runtimeHints) {
        await input.runtimeHints.apply({ appId: input.appBundleId, values: input.runtimeHints.values });
      }
      const runtimeHintsDurationMs = Date.now() - started;
      const result = await openApplication(input);
      return input.runtimeHints ? { ...result, timing: { ...result.timing, runtimeHintsDurationMs } } : result;
    },
    configureProviderPortReverse: reverse,
  };
}

async function publishMapping(directory, mapping) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, mapping.token + ".json");
  const temporary = filePath + ".pending";
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(mapping) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  return filePath;
}

export function metroPorts(call, serial, leaseId, { transportId, assertHeld,
  root = path.join(homedir(), ".agent-device", "headunit-claims", "metro"),
}) {
  const directory = path.join(root, createHash("sha256").update(serial).digest("hex"));
  const active = new Set();
  let pending = Promise.resolve();
  let closing = false;
  function serialize(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  }

  async function removeMapping(filePath, mapping) {
    assertHeld();
    await call({ op: "portReverse", ...mapping, remove: true });
    await unlink(filePath);
    active.delete(filePath);
  }

  async function reconcile(includeActive) {
    assertHeld();
    let names;
    try { names = await readdir(directory); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    const errors = [];
    for (const name of names.filter((name) => journalFilePattern.test(name))) {
      const filePath = path.join(directory, name);
      if (!includeActive && active.has(filePath)) continue;
      try {
        if (name.endsWith(".pending")) {
          await unlink(filePath);
          continue;
        }
        const mapping = JSON.parse(await readFile(filePath, "utf8"));
        if (mapping.serial !== serial || name !== mapping.token + ".json" ||
            typeof mapping.transportId !== "string" || !transportIdPattern.test(mapping.transportId) ||
            !validPort(mapping.devicePort) || !validPort(mapping.hostPort)) {
          throw new Error("Invalid Open Headunit Metro ownership record.");
        }
        const { devicePort, hostPort, token, transportId } = mapping;
        await removeMapping(filePath, { serial, devicePort, hostPort, token, transportId });
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Could not release the projection's Metro ports.");
  }

  return {
    configure(input, signal) {
      return serialize(async () => {
        if (closing || input.leaseId !== leaseId || input.provider !== "headunit") return;
        signal?.throwIfAborted();
        const { devicePort, hostPort, name } = input;
        if (typeof transportId !== "string" || !transportIdPattern.test(transportId)) {
          throw new Error("Open Headunit could not identify the projecting phone's ADB transport for Metro.");
        }
        if (!validPort(devicePort) || !validPort(hostPort)) throw new Error("Metro requires valid device and host ports.");
        await reconcile(false);
        signal?.throwIfAborted();
        assertHeld();
        const mapping = { serial, transportId, devicePort, hostPort, token: randomBytes(16).toString("hex") };
        const filePath = await publishMapping(directory, mapping);
        try {
          assertHeld();
          const { created } = await call({ op: "portReverse", ...mapping });
          if (created) active.add(filePath);
          else await unlink(filePath);
        } catch (error) {
          try { await removeMapping(filePath, mapping); }
          catch (cleanupError) {
            throw new AggregateError([error, cleanupError], error.message, { cause: error });
          }
          throw error;
        }
        return { leaseId, devicePort, hostPort, name };
      });
    },
    cleanup() {
      closing = true;
      return serialize(() => reconcile(true));
    },
  };
}
