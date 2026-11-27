import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { backendFile } from "./backend-file.mjs";

const requestTimeoutMs = 35000;
const maxRequestBytes = 6 * 1024 * 1024;
const maxReplyBytes = 32 * 1024 * 1024;

function backendLauncher(options, host, sessionEnv) {
  const backend = options.backend ?? backendFile("headunit.py");
  const python = options.python ?? host.env.HEADUNIT_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  return (mode, signal) => {
    if (!backend || !path.isAbsolute(backend) || !existsSync(backend)) {
      throw new Error("Set the headunit plugin's backend option to the absolute path of headunit.py.");
    }
    return spawn(python, ["-B", "-u", backend, mode], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(sessionEnv && { env: { ...process.env, ...sessionEnv } }),
      signal,
    });
  };
}

export function rpcClient(options, host, sessionEnv) {
  const launch = backendLauncher(options, host, sessionEnv);
  return (request, signal) => new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const child = launch("rpc", cancellation);
    const chunks = [];
    const errors = [];
    let size = 0;
    let exited = false, framed = false, settled = false;
    function finish(error, reply) {
      if (settled) return;
      settled = true;
      cancellation.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(reply);
    }
    function onAbort() { finish(cancellation.reason); }
    function readReply() {
      if (!exited || !framed || settled) return;
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        const reply = raw ? JSON.parse(raw) : null;
        if (child.exitCode !== 0 || reply?.ok !== true) {
          throw new Error(reply?.error || Buffer.concat(errors).toString("utf8").trim() ||
            "Headunit backend exited without a successful response.");
        }
        finish(null, reply);
      } catch (error) { finish(error); }
    }
    cancellation.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxReplyBytes) {
        child.kill();
        finish(new Error("Headunit response exceeded 32 MiB."));
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(10)) { framed = true; readReply(); }
    });
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", finish);
    child.stdin.on("error", finish);
    // A Frida helper can retain the output pipe after Python has returned its complete reply.
    child.once("exit", () => { exited = true; readReply(); });
    child.stdout.once("end", () => { framed = true; readReply(); });
    child.stdin.end(JSON.stringify(request));
  });
}

export function sessionRpcClient(options, host, sessionEnv) {
  const launch = backendLauncher(options, host, sessionEnv);
  const waiting = new Set();
  let worker, active, closing;

  function finish(item, error, result) {
    waiting.delete(item);
    if (active === item) active = undefined;
    item.signal.removeEventListener("abort", item.abort);
    if (error) item.reject(error);
    else item.resolve(result);
  }

  function interrupt(instance, error) {
    if (instance !== worker || instance.stopping) return;
    instance.stopping = true;
    if (active) finish(active, error);
    instance.child.kill();
  }

  function start() {
    const child = launch("rpc-worker");
    const { promise: exited, resolve: markExited } = Promise.withResolvers();
    const instance = { child, exited, stderr: Buffer.alloc(0), stopping: false };
    function onExit(error) {
      if (worker !== instance) return;
      if (active) finish(active, error ?? new Error(instance.stderr.toString("utf8").trim() ||
        "The Headunit worker exited before acknowledging the command. Check the screen before repeating input."));
      worker = undefined;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      markExited();
      pump();
    }
    child.once("exit", () => onExit());
    child.on("error", (error) => {
      if (child.pid === undefined) onExit(error);
      else interrupt(instance, error);
    });
    child.stdin.on("error", (error) => interrupt(instance, error));
    child.stdout.on("error", (error) => interrupt(instance, error));
    child.stdout.once("end", () => interrupt(instance, new Error("The Headunit worker closed its response stream.")));
    child.stderr.on("data", (chunk) => {
      instance.stderr = Buffer.concat([instance.stderr, chunk]).subarray(-16384);
    });
    child.stdout.on("data", (chunk) => {
      if (worker !== instance || instance.stopping) return;
      if (!active) {
        interrupt(instance, new Error("Unexpected response from the Headunit worker."));
        return;
      }
      active.bytes += chunk.length;
      if (active.bytes > maxReplyBytes) {
        interrupt(instance, new Error("Headunit response exceeded 32 MiB."));
        return;
      }
      active.chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      let reply;
      try {
        if (newline !== chunk.length - 1) throw new Error("Unexpected additional response data.");
        reply = JSON.parse(Buffer.concat(active.chunks).toString("utf8"));
        if (typeof reply?.ok !== "boolean") throw new Error("Invalid response from the Headunit worker.");
      } catch (error) {
        interrupt(instance, error);
        return;
      }
      finish(active, reply.ok ? undefined : new Error(reply.error || "The Headunit command failed."), reply);
      pump();
    });
    return instance;
  }

  function pump() {
    if (closing || active || worker?.stopping) return;
    for (const item of waiting) {
      waiting.delete(item);
      if (item.signal.aborted) {
        finish(item, item.signal.reason);
        continue;
      }
      try { worker ??= start(); }
      catch (error) {
        finish(item, error);
        continue;
      }
      active = item;
      const instance = worker;
      instance.stderr = Buffer.alloc(0);
      instance.child.stdin.write(item.frame, (error) => {
        if (error) interrupt(instance, error);
      });
      return;
    }
  }

  const call = (request, signal) => new Promise((resolve, reject) => {
    if (closing) throw new Error("The Headunit session has closed.");
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
    cancellation.throwIfAborted();
    const frame = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(frame) > maxRequestBytes) throw new Error("Headunit request exceeded 6 MiB.");
    const item = { frame, signal: cancellation, resolve, reject, bytes: 0, chunks: [] };
    item.abort = () => {
      if (active === item) interrupt(worker, cancellation.reason);
      else finish(item, cancellation.reason);
    };
    cancellation.addEventListener("abort", item.abort, { once: true });
    waiting.add(item);
    pump();
  });
  call.close = () => {
    if (closing) return closing;
    const instance = worker;
    closing = instance?.exited ?? Promise.resolve();
    const error = new Error("The Headunit session has closed.");
    for (const item of waiting) finish(item, error);
    if (instance) {
      if (active) interrupt(instance, error);
      else if (!instance.stopping) {
        instance.stopping = true;
        instance.child.stdin.end();
      }
      const timer = setTimeout(() => instance.child.kill(), 3000);
      void closing.then(() => clearTimeout(timer));
    }
    return closing;
  };
  return call;
}
