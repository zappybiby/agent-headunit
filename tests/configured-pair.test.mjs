import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredPair } from "../provider/configured-pair.mjs";

const config = { phoneAvd: "projecting_phone", receiverAvd: "car_receiver" };
const phone = { serial: "emulator-5554", transportId: "26", booted: true };
const receiver = { serial: "emulator-5556", transportId: "28", booted: true };
const selector = { platform: "android", deviceName: "headunit:projecting_phone" };
const createError = (code, message) => Object.assign(new Error(message), { code });

test("only the named provider pair appears without a lease and stopped members stay stopped", async () => {
  const calls = [];
  const pair = configuredPair(config, { createError, call: async (request) => {
    calls.push(request);
    return { members: [null, null] };
  } });
  assert.equal(await pair.discover({ platform: "android" }), null);
  assert.equal(await pair.discover({ deviceName: "projecting_phone" }), null);
  assert.equal(calls.length, 0);
  const [device] = await pair.discover(selector);
  assert.equal(device.name, selector.deviceName);
  assert.equal(device.booted, false);
  assert.equal(pair.ownsDevice(device), true);
  assert.deepEqual(calls, [{ op: "pairStatus", ...config }]);
});

test("unleased appstate refuses a replacement transport and addresses both members", async () => {
  const signal = new AbortController().signal;
  let scans = 0;
  const pair = configuredPair(config, { createError, call: async (request, requestSignal) => {
    assert.equal(requestSignal, signal);
    if (request.op === "pairStatus") {
      scans++;
      return { members: [phone, { ...receiver, transportId: scans === 1 ? "28" : "30" }] };
    }
    assert.deepEqual(request, { op: "appstate", serial: phone.serial, receiver: receiver.serial });
    return { package: "com.example.maps" };
  } });
  const operations = pair.bind({ host: {}, scope: { signal } });
  assert.equal((await operations.ensureReady()).booted, true);
  await assert.rejects(operations.appState(), { code: "DEVICE_NOT_FOUND" });
  assert.equal(scans, 2);
});
