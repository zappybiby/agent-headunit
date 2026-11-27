import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { projectedTouchHelper } from "../projection/touch.mjs";
import { backendFile } from "../runtime/backend-file.mjs";

const maxFrameBytes = 16 * 1024;
const cleanupGraceMs = 60000;
const avdName = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;
const emulatorSerial = /^emulator-[1-9]\d*$/;

export class ManagedProjectionCleanupError extends Error {}

function sessionScript(backend) {
  if (backend) {
    if (!path.isAbsolute(backend)) throw new Error("The Open Headunit backend path must be absolute.");
    return path.join(path.dirname(backend), "open_headunit_session.py");
  }
  return backendFile("open_headunit_session.py");
}

function readyFields(line) {
  const { phone, receiver, fridaSession, touch } = JSON.parse(line);
  const helper = projectedTouchHelper(touch?.jar, touch?.root);
  if (typeof phone !== "string" || !emulatorSerial.test(phone) || typeof receiver !== "string" ||
      !emulatorSerial.test(receiver) || phone === receiver || typeof fridaSession !== "string" ||
      !path.isAbsolute(fridaSession) || (touch != null && !helper)) {
    throw new Error("The managed Open Headunit service returned invalid projection details.");
  }
  return { phone, receiver, fridaSession, touch: helper };
}

export async function startManagedProjection({ phoneAvd, receiverAvd, fridaServer, audio, python, backend }, {
  signal, deadline = Date.now() + 300000,
} = {}) {
  signal?.throwIfAborted();
  if (typeof phoneAvd !== "string" || !avdName.test(phoneAvd) || typeof receiverAvd !== "string" ||
      !avdName.test(receiverAvd) || phoneAvd === receiverAvd) {
    throw new Error("Configure two distinct Android AVD names for managed Open Headunit.");
  }
  if (typeof fridaServer !== "string" || !path.isAbsolute(fridaServer)) {
    throw new Error("Configure an absolute path to the Android Frida server for managed Open Headunit.");
  }
  if (!statSync(fridaServer, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`No Frida server file was found at ${fridaServer}.`);
  }
  const script = sessionScript(backend);
  if (!existsSync(script)) throw new Error(`The managed Open Headunit service is missing at ${script}.`);
  const timeoutError = new Error("The managed Open Headunit service exceeded its allocation deadline.");
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw timeoutError;

  const args = ["-B", "-u", script, "--phone-avd", phoneAvd, "--receiver-avd", receiverAvd,
    "--frida-server", fridaServer, "--managed-service", ...(audio === true ? ["--with-audio"] : [])];
  const interpreter = python ?? (process.platform === "win32" ? "python" : "python3");
  const child = spawn(interpreter, args, {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-maxFrameBytes);
  });
  child.stdin.on("error", () => {});
  const { promise: exited, resolve: exitedWith } = Promise.withResolvers();
  let exitResult;
  let spawnError;
  child.on("error", (error) => {
    if (child.pid === undefined) spawnError = error;
  });
  child.once("close", (code, signal) => {
    exitResult = { code, signal, error: spawnError };
    exitedWith(exitResult);
  });

  function statusError(message, status, ErrorType = Error) {
    if (status.error?.code === "ENOENT" || status.error?.code === "EACCES") {
      return new ErrorType(`Could not run Python at ${JSON.stringify(interpreter)}. Install Python or set HEADUNIT_PYTHON to a runnable interpreter.`, {
        cause: status.error,
      });
    }
    const detail = stderr.toString("utf8").trim() || status.error?.message || status.signal || status.code;
    return new ErrorType(detail == null ? message : `${message} ${detail}`, { cause: status.error });
  }

  let stopping;
  function requestStop() {
    stopping ??= (async () => {
      stopWatchingStartup();
      child.stdin.end();
      let forced = false;
      const watchdog = setTimeout(() => {
        forced = true;
        try { child.kill("SIGKILL"); }
        finally {
          child.stdout.destroy();
          child.stderr.destroy();
        }
      }, cleanupGraceMs);
      try {
        return { ...(await exited), forced };
      } finally {
        clearTimeout(watchdog);
        child.stdout.destroy();
        child.stderr.destroy();
      }
    })();
    return stopping;
  }

  const ready = Promise.withResolvers();
  let buffered = Buffer.alloc(0);
  function readReady(chunk) {
    const newline = chunk.indexOf(10);
    const length = newline < 0 ? chunk.length : newline;
    if (buffered.length + length > maxFrameBytes) {
      ready.reject(new Error("The managed Open Headunit service exceeded its startup response limit."));
      return;
    }
    buffered = Buffer.concat([buffered, chunk.subarray(0, length)]);
    if (newline < 0) return;
    try {
      ready.resolve(readyFields(buffered.toString("utf8")));
    } catch (error) {
      ready.reject(new Error("The managed Open Headunit service returned an invalid startup response.", { cause: error }));
    }
  }

  const stopWaiting = Promise.withResolvers();
  let prepared = false;
  let startupFailure;
  function cancelStartup(error) {
    startupFailure = error;
    stopWaiting.reject(error);
    if (prepared) void requestStop();
  }
  const onAbort = () => cancelStartup(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  const startupTimer = setTimeout(() => cancelStartup(timeoutError), Math.min(remaining, 2147483647));
  function stopWatchingStartup() {
    clearTimeout(startupTimer);
    signal?.removeEventListener("abort", onAbort);
    signal = undefined;
  }

  child.stdout.on("data", readReady);
  try {
    const fields = await Promise.race([
      ready.promise,
      exited.then((status) => { throw statusError("The managed Open Headunit service exited before becoming ready.", status); }),
      stopWaiting.promise,
    ]);
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw timeoutError;
    if (exitResult) throw statusError("The managed Open Headunit service exited during setup.", exitResult);
    prepared = true;
    let adoption;
    return Object.freeze({
      ...fields,
      async adopt() {
        if (adoption) return adoption;
        if (startupFailure) throw startupFailure;
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw timeoutError;
        if (stopping) throw new Error("The managed Open Headunit service is closing.");
        if (exitResult) throw statusError("The managed Open Headunit service exited before adoption.", exitResult);
        adoption = new Promise((resolve, reject) => {
          child.stdin.write("+", (error) => error ? reject(error) : resolve());
        }).catch(async (error) => {
          await requestStop();
          throw error;
        });
        stopWatchingStartup();
        return adoption;
      },
      async close() {
        const status = await requestStop();
        if (status.forced || status.code !== 0) {
          throw statusError("The managed Open Headunit service could not confirm cleanup.", status, ManagedProjectionCleanupError);
        }
      },
    });
  } catch (error) {
    const status = await requestStop();
    if (status.forced) {
      throw new Error("The managed Open Headunit service was stopped after its cleanup deadline.", { cause: error });
    }
    throw error;
  } finally {
    child.stdout.off("data", readReady);
    child.stdout.resume();
  }
}
