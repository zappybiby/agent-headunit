import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectionDeviceFacts, projectionInventory, webDriverDevice } from '../../../provider/projection/device.mjs';

const androidDevice = Object.freeze({ platform: 'android', target: 'mobile', kind: 'device', booted: true });

test('inventory publishes only confirmed emulator pairs and keeps the underlying receiver', async () => {
  const expectedRequest = { leaseProvider: 'headunit' };
  const expectedSignal = new AbortController().signal;
  const confirmed = { ...androidDevice, id: 'headunit:confirmed' };
  const unconfirmed = { ...androidDevice, id: 'headunit:emulator-9999' };
  const emulatorIds = new Set();
  const runtime = {
    devices: [confirmed, unconfirmed],
    async deviceInventoryProvider(request, signal) {
      assert.equal(this, runtime);
      assert.equal(request, expectedRequest);
      assert.equal(signal, expectedSignal);
      return this.devices;
    },
  };
  const inventory = projectionInventory(runtime, emulatorIds);
  assert.deepEqual(await inventory(expectedRequest, expectedSignal), [confirmed, unconfirmed]);
  emulatorIds.add(confirmed.id);
  assert.deepEqual(await inventory(expectedRequest, expectedSignal), [
    { ...confirmed, kind: 'emulator' }, unconfirmed,
  ]);
  assert.equal(confirmed.kind, 'device');
  runtime.devices = [];
  assert.deepEqual(await inventory(expectedRequest, expectedSignal), []);
  runtime.devices = null;
  assert.equal(await inventory(expectedRequest, expectedSignal), null);
});

test('WebDriver sees its original kind while public bindings preserve current and saved kinds', () => {
  const saved = { ...androidDevice, id: 'headunit:confirmed' };
  const current = { ...saved, kind: 'emulator' };
  const facts = {
    device: { family: 'android', kind: 'device', target: 'mobile', providerMode: 'provider-runtime' },
    operations: { captureScreenshot: { available: true }, captureSnapshot: { available: true } },
  };
  assert.deepEqual(webDriverDevice(current), saved);
  assert.equal(webDriverDevice(saved), saved);
  assert.deepEqual(projectionDeviceFacts(facts, current).device, { ...facts.device, kind: 'emulator' });
  assert.equal(projectionDeviceFacts(facts, current).operations, facts.operations);
  assert.equal(projectionDeviceFacts(facts, saved), facts);
  assert.equal(current.kind, 'emulator');
});
