import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function publishMarker(destination, marker) {
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.app-log-${randomUUID()}.tmp`);
  let file;
  let created = false;
  let linked = false;
  let published = false;
  try {
    file = fs.openSync(temporary, "wx", 0o600);
    created = true;
    fs.writeFileSync(file, JSON.stringify(marker) + "\n", "utf8");
    fs.fsyncSync(file);
    fs.closeSync(file);
    file = undefined;
    fs.linkSync(temporary, destination);
    linked = true;
    fs.unlinkSync(temporary);
    published = true;
  } finally {
    if (!published) {
      if (file !== undefined) {
        try { fs.closeSync(file); } catch { /* Preserve the publication failure. */ }
      }
      if (linked) {
        try { fs.unlinkSync(destination); } catch { /* Preserve the publication failure. */ }
      }
      if (created) {
        try { fs.unlinkSync(temporary); } catch { /* Preserve the publication failure. */ }
      }
    }
  }
}

async function requireAbsentMarker(processes, markerPath) {
  if ((await processes.readMarker(markerPath)).status !== "missing") {
    throw new Error("Existing app-log process marker evidence must be recovered before start.");
  }
}

async function clearOwnMarker(processes, markerPath, marker) {
  const current = await processes.readMarker(markerPath);
  if (current.status === "decoded" && current.marker.pid === marker.pid &&
      current.marker.startTime === marker.startTime && current.marker.command === marker.command) {
    await processes.clearMarker(markerPath);
  }
}

function portableStart(processes, start) {
  return async (request, signal) => {
    if (!request.markerPath) return await start(request, signal);
    const markerPath = path.resolve(request.markerPath);
    signal?.throwIfAborted();
    await requireAbsentMarker(processes, markerPath);
    signal?.throwIfAborted();
    const background = await start({ ...request, markerPath: undefined }, signal);
    void background.wait.catch(() => undefined);
    const { marker } = background;
    try {
      if (!marker) throw new Error("Managed app-log process did not expose a complete ownership marker.");
      signal?.throwIfAborted();
      await requireAbsentMarker(processes, markerPath);
      signal?.throwIfAborted();
      publishMarker(markerPath, marker);
    } catch (error) {
      await background.terminate().catch(() => undefined);
      await background.wait.catch(() => undefined);
      throw error;
    }

    const wait = background.wait.finally(() => clearOwnMarker(processes, markerPath, marker));
    void wait.catch(() => undefined);
    let termination;
    const terminate = () => termination ??= (async () => {
      await background.terminate();
      await wait.catch(() => undefined);
    })();
    return Object.freeze({ ...background, wait, terminate, [Symbol.asyncDispose]: terminate });
  };
}

export function withPortableAppLogMarkers(host) {
  if (process.platform !== "win32") return host;
  const { processes, processTransports } = host;
  return Object.freeze({
    ...host,
    processes: Object.freeze({ ...processes, start: portableStart(processes, processes.start.bind(processes)) }),
    processTransports: Object.freeze({ ...processTransports, async resolve(...args) {
      const transport = await processTransports.resolve(...args);
      return transport.start ? Object.freeze({ ...transport, start: portableStart(processes, transport.start.bind(transport)) }) : transport;
    } }),
  });
}
