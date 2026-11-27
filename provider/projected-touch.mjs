import { spawn } from "node:child_process";

const deviceJarPath = /^\/data\/local\/tmp\/headunit-touch-[a-f0-9]{16}\.jar$/;
const suPath = /^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*su$/;

export function projectedTouchHelper(jar, root) {
  if (typeof jar !== "string" || !deviceJarPath.test(jar) ||
      typeof root !== "string" || !(root === "adb-root" || root === "su" || suPath.test(root))) return;
  return Object.freeze({ jar, root });
}

export function projectedTouchCommand(helper) {
  const touch = projectedTouchHelper(helper?.jar, helper?.root);
  if (!touch) throw new Error("No projected touch helper is installed for this phone.");
  const command = `CLASSPATH=${touch.jar} app_process /system/bin headunit.agent.ProjectedTouch`;
  return touch.root === "adb-root" ? command : `${touch.root} -c '${command}'`;
}

export function runProjectedTouch(serial, helper, plan, signal) {
  signal.throwIfAborted();
  if (typeof serial !== "string" || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(serial)) {
    throw new Error("Invalid projecting phone serial for the touch helper.");
  }
  const command = projectedTouchCommand(helper);
  return new Promise((resolve, reject) => {
    const child = spawn("adb", ["-s", serial, "shell", "-T", command],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let reply = "", abortTimer, spawnError;
    const timeout = AbortSignal.timeout(70000);
    const stop = () => {
      if (abortTimer !== undefined) return;
      if (!child.stdin.destroyed) child.stdin.end("cancel\n");
      abortTimer = setTimeout(() => child.kill(), 3000);
    };
    function cleanup() {
      clearTimeout(abortTimer);
      signal.removeEventListener("abort", stop);
      timeout.removeEventListener("abort", stop);
    }
    child.on("error", (error) => { spawnError = error; });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") spawnError = error; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => {
      if (reply.length < 4096) reply += part.slice(0, 4096 - reply.length);
    });
    child.once("close", (code) => {
      cleanup();
      try {
        if (spawnError) throw spawnError;
        const status = JSON.parse(reply.trim()).status;
        if (code === 0 && (status === "success" || status === "canceled")) {
          resolve(status);
          return;
        }
      } catch {
        if (!reply.trim()) {
          reject(new Error("The projecting phone did not acknowledge the projected touch plan."));
          return;
        }
      }
      reject(new Error("Android did not complete the projected touch plan."));
    });
    signal.addEventListener("abort", stop, { once: true });
    timeout.addEventListener("abort", stop, { once: true });
    child.stdin.write(JSON.stringify(plan) + "\n");
    if (signal.aborted) stop();
  });
}
