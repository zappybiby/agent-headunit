import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../provider/cli/artifacts.mjs", import.meta.url));

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
    delete cleanEnv.AGENT_DEVICE_TENANT;
    delete cleanEnv.AGENT_DEVICE_LEASE_ID;
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...cleanEnv, ...env },
    });
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, body: JSON.parse(stdout) }));
  });
}

test("loopback inventory and download use local host output without asserting a tenant", async () => {
  const headers = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    if (req.url === "/artifacts") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ artifacts: [{ id: "one", filename: "clip.mp4", sizeBytes: 4, sessionName: "test" }] }));
    } else if (req.url === "/artifacts/one") {
      res.setHeader("content-length", "4");
      res.end("clip");
    } else { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "headunit-artifacts-test-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { AGENT_DEVICE_DAEMON_BASE_URL: url, AGENT_DEVICE_DAEMON_AUTH_TOKEN: "test-token" };
    const list = await run(["list", "--session", "test", "--json"], env);
    assert.equal(list.code, 0);
    assert.equal(list.body.data.artifacts[0].id, "one");
    const out = path.join(dir, "clip.mp4");
    const download = await run(["download", "one", "--out", out, "--json"], env);
    assert.equal(download.code, 0);
    assert.equal(await readFile(out, "utf8"), "clip");
    assert.equal(headers[0].authorization, "Bearer test-token");
    assert.equal(headers[0]["x-agent-device-tenant"], undefined);
    const duplicate = await run(["download", "one", "--out", out, "--json"], env);
    assert.equal(duplicate.code, 1);
    assert.match(duplicate.body.error.message, /already exists/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("remote daemon requires an authenticated tenant", async () => {
  const result = await run(["list", "--daemon-url", "https://example.com", "--json"]);
  assert.equal(result.code, 1);
  assert.match(result.body.error.message, /AUTH_TOKEN/);
});

test("a scoped inventory and download carry the exact session and lease to the daemon", async () => {
  const scoped = [{ id: "only", filename: "clip.mp4", sizeBytes: 4, sessionName: "car & tools" }];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.headers["x-agent-device-lease-id"] !== "selected" ||
        req.headers["x-agent-device-tenant"] !== "team" ||
        url.searchParams.get("session") !== "car & tools") {
      res.writeHead(401).end();
    } else if (url.pathname === "/artifacts") {
      res.end(JSON.stringify({ artifacts: scoped }));
    } else if (url.pathname === "/artifacts/only") {
      res.setHeader("content-length", "4");
      res.end("clip");
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(path.join(os.tmpdir(), "headunit-scoped-artifact-"));
  try {
    const env = { AGENT_DEVICE_DAEMON_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "test-token", AGENT_DEVICE_TENANT: "team" };
    const scope = ["--lease-id", "selected", "--session", "car & tools", "--json"];
    assert.deepEqual((await run(["list", ...scope], env)).body.data.artifacts, scoped);
    const output = path.join(dir, "clip.mp4");
    assert.equal((await run(["download", "only", "--out", output, ...scope], env)).code, 0);
    assert.equal(await readFile(output, "utf8"), "clip");
    const missingLease = await run(["download", "only", "--out", output, "--session", "car & tools", "--json"], env);
    assert.match(missingLease.body.error.message, /lease-id/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
