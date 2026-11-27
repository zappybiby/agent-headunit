export function projectionInventory(runtime, emulatorIds) {
  const inventory = runtime.deviceInventoryProvider.bind(runtime);
  return async (request, signal) => {
    const devices = await inventory(request, signal);
    if (devices == null) return devices;
    return devices.map((device) => emulatorIds.has(device.id)
      ? { ...device, kind: 'emulator' }
      : device);
  };
}

export function webDriverDevice(device) {
  // The shared WebDriver runtime admits Android mobile devices only with this kind.
  return device.kind === 'emulator' ? { ...device, kind: 'device' } : device;
}

export function projectionDeviceFacts(facts, device) {
  if (facts.device.kind === device.kind) return facts;
  return Object.freeze({ ...facts, device: Object.freeze({ ...facts.device, kind: device.kind }) });
}
