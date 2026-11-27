#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const transferTimeoutMs = 90000;
const maxInventoryBytes = 4 * 1024 * 1024;
const artifactId = /^[a-zA-Z0-9_-]{1,128}$/;
const tenantId = /^[a-zA-Z0-9._-]{1,128}$/;
const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

const help = `Usage
  open-headunit-artifacts list [--session <name>] [--json]
  open-headunit-artifacts download <artifact-id> --out <file> [--session <name>] [--json]

Set --daemon-url (or AGENT_DEVICE_DAEMON_BASE_URL). Remote daemons require --tenant
(or AGENT_DEVICE_TENANT) and AGENT_DEVICE_DAEMON_AUTH_TOKEN. Loopback can use the
daemon token without declaring a tenant. Gateways can use --lease-id or AGENT_DEVICE_LEASE_ID.`;

function connection(values, env) {
  let base;
  try {
    base = new URL(values["daemon-url"] ?? env.AGENT_DEVICE_DAEMON_BASE_URL);
  } catch {
    throw new Error("Set a daemon URL with --daemon-url or AGENT_DEVICE_DAEMON_BASE_URL.");
  }
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && loopbackHosts.has(base.hostname)))) {
    throw new Error("Use an HTTPS daemon URL or HTTP on loopback, without credentials, query, or fragment.");
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  const local = base.protocol === "http:" && loopbackHosts.has(base.hostname);
  const token = env.AGENT_DEVICE_DAEMON_AUTH_TOKEN?.trim();
  if ((!local && !token) || (token && /[^!-~]/.test(token))) throw new Error("Set AGENT_DEVICE_DAEMON_AUTH_TOKEN to the daemon bearer token.");
  const tenant = (values.tenant ?? env.AGENT_DEVICE_TENANT)?.trim();
  if ((!local && !tenant) || (tenant !== undefined && !tenantId.test(tenant))) throw new Error("Set a valid tenant with --tenant or AGENT_DEVICE_TENANT.");
  if (tenant && !token) throw new Error("Set AGENT_DEVICE_DAEMON_AUTH_TOKEN when specifying a tenant.");
  const lease = (values["lease-id"] ?? env.AGENT_DEVICE_LEASE_ID)?.trim();
  if (lease !== undefined && !artifactId.test(lease)) throw new Error("Specify a valid daemon lease ID.");
  return {
    base,
    headers: {
      ...(token && { authorization: `Bearer ${token}`, "x-agent-device-token": token }),
      ...(tenant && { "x-agent-device-tenant": tenant }),
      "accept-encoding": "identity",
      ...(lease && { "x-agent-device-lease-id": lease }),
    },
  };
}

async function request({ base, headers }, route, signal) {
  const response = await fetch(new URL(route, base), { headers, signal, redirect: "manual" });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`The daemon did not return the requested artifacts (HTTP ${response.status}).`);
  }
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding !== "identity") {
    await response.body.cancel();
    throw new Error("The daemon sent an encoded artifact response.");
  }
  return response;
}

async function listArtifacts(endpoint, session, signal) {
  const query = artifactSessionQuery(endpoint, session);
  const response = await request(endpoint, "artifacts" + query, signal);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxInventoryBytes) throw new Error("The daemon artifact list exceeded 4 MiB.");
    chunks.push(chunk);
  }
  let inventory;
  try { inventory = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The daemon returned an invalid artifact inventory."); }
  const artifacts = inventory?.artifacts;
  if (!Array.isArray(artifacts) || artifacts.some((entry) =>
    !entry || typeof entry.id !== "string" || !artifactId.test(entry.id) || typeof entry.filename !== "string" ||
    !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) {
    throw new Error("The daemon returned an invalid artifact inventory.");
  }
  return { artifacts: session === undefined ? artifacts : artifacts.filter((entry) => entry.sessionName === session) };
}

function artifactSessionQuery(endpoint, session) {
  return session && endpoint.headers["x-agent-device-lease-id"] ? "?" + new URLSearchParams({ session }) : "";
}

async function assertDestinationAbsent(destination) {
  try {
    await lstat(destination);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The destination already exists. ${destination}`);
}

async function downloadArtifact(endpoint, id, out, session, signal) {
  const query = artifactSessionQuery(endpoint, session);
  if (session !== undefined && !query) throw new Error("Specify --lease-id or AGENT_DEVICE_LEASE_ID with --session.");
  const destination = path.resolve(out);
  await mkdir(path.dirname(destination), { recursive: true });
  const parent = await realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  await assertDestinationAbsent(target);

  const staged = path.join(parent, `.headunit-artifact-${randomUUID()}.tmp`);
  const file = await open(staged, "wx", 0o600);
  try {
    const response = await request(endpoint, `artifacts/${encodeURIComponent(id)}${query}`, signal);
    const declaredLength = response.headers.get("content-length");
    const expected = declaredLength === null ? undefined : Number(declaredLength);
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) {
      await response.body.cancel();
      throw new Error("The daemon returned an invalid artifact length.");
    }
    let sizeBytes = 0;
    const count = new Transform({
      transform(chunk, _encoding, callback) {
        sizeBytes += chunk.length;
        callback(undefined, chunk);
      },
    });
    await pipeline(response.body, count, file.createWriteStream(), { signal });
    if (expected !== undefined && sizeBytes !== expected) throw new Error("The artifact download was incomplete.");
    signal.throwIfAborted();
    // The link publishes the full file and fails if another process created the destination.
    await link(staged, target);
    return { id, path: destination, sizeBytes };
  } finally {
    try { await file.close(); }
    finally {
      await unlink(staged).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      "daemon-url": { type: "string" }, tenant: { type: "string" }, "lease-id": { type: "string" },
      session: { type: "string" }, out: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } });
    if (values.help) {
      console.log(help);
      return 0;
    }
    const [command, id] = positionals;
    const list = command === "list" && positionals.length === 1 && values.out === undefined;
    const download = command === "download" && positionals.length === 2 && artifactId.test(id) &&
      Boolean(values.out?.trim());
    if (!list && !download) throw new Error("Use list or download <artifact-id> --out <file>. See --help.");
    const endpoint = connection(values, env);
    const signal = AbortSignal.timeout(transferTimeoutMs);
    const data = list
      ? await listArtifacts(endpoint, values.session, signal)
      : await downloadArtifact(endpoint, id, values.out, values.session, signal);
    if (values.json) console.log(JSON.stringify({ success: true, data }));
    else if (list) {
      if (data.artifacts.length === 0) console.log("No daemon artifacts available.");
      else for (const entry of data.artifacts) {
        console.log(`${entry.id}  ${JSON.stringify(entry.filename)}  ${entry.sizeBytes} bytes`);
      }
    } else console.log(data.path);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ success: false, error: { message } }));
    else console.error(message);
    return 1;
  }
}

let invokedPath;
try { if (process.argv[1]) invokedPath = realpathSync(process.argv[1]); }
catch { /* The module is imported without a file entry point. */ }
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
