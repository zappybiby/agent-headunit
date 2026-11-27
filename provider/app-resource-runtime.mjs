const startPackages = { appLogStart: "appBundleId", perfNativeCaptureStart: "appId" };
const recoveryKinds = {
  appLogReattach: "app-log",
  appLogCleanup: "app-log",
  perfNativeCaptureReattach: "perf-capture",
  perfNativeCaptureCleanup: "perf-capture",
};
const operations = [
  "appLogInspect", "appLogDoctor", "perfMemorySnapshot", "perfProfileReport",
  ...Object.keys(startPackages), ...Object.keys(recoveryKinds),
];
const inactive = Object.freeze({ available: false, reason: "owner-capability-missing" });
const packagePattern = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)(?:\/[A-Za-z_.$][\w.$]*)?$/;

export function appResourceFacts(nativeRuntimeFacts, live) {
  return Object.fromEntries(operations.map((operation) => [operation,
    (live || Object.hasOwn(recoveryKinds, operation)) ? nativeRuntimeFacts?.operations?.[operation] ?? inactive : inactive,
  ]));
}

function packageName(target) {
  return typeof target === "string" ? packagePattern.exec(target)?.[1] : undefined;
}

function ownsEnvelope(envelope, resourceKind, projection, owner) {
  return envelope?.resourceKind === resourceKind &&
    envelope.device?.id === projection.id && envelope.device.family === projection.family &&
    envelope.device.kind === projection.kind && envelope.device.target === projection.target &&
    envelope.owner?.kind === owner.kind && envelope.owner.provider === owner.provider &&
    envelope.owner.instance === owner.instance;
}

export function bindAppResourceOperations({ facts, bindNative, projection, owner, deviceIdentity, createError, resolvePackage }) {
  async function pinPackage(target, operation) {
    const direct = packageName(target);
    if (direct) return direct;
    if (typeof target === "string" && target && resolvePackage) {
      const resolved = packageName(await resolvePackage(target));
      if (resolved) return resolved;
    }
    throw createError("INVALID_ARGS", `Select a projected Android app by package for ${operation}.`, { dispatched: "no" });
  }

  function runNative(operation, call) {
    return bindNative((binding) => {
      const fact = binding.facts.operations[operation];
      const method = binding.operations[operation];
      if (!fact?.available || typeof method !== "function") {
        throw createError("UNSUPPORTED_OPERATION", fact?.hint ?? `The projecting phone does not support ${operation}.`, {
          reason: fact?.reason ?? inactive.reason, dispatched: "no",
        });
      }
      return call(method, binding);
    });
  }

  async function invoke(operation, input) {
    if (Object.hasOwn(recoveryKinds, operation)) {
      const { envelope } = input;
      if (!ownsEnvelope(envelope, recoveryKinds[operation], projection, owner)) {
        throw createError("INVALID_ARGS", "The app capture belongs to another projection or runtime.", { dispatched: "no" });
      }
      return await runNative(operation, (method, binding) => method({
        ...input, envelope: { ...envelope, device: deviceIdentity(binding.device), owner: binding.owner },
      }));
    }
    if (Object.hasOwn(startPackages, operation)) {
      const field = startPackages[operation];
      const target = await pinPackage(input[field], operation);
      const started = await runNative(operation, (method) => method({ ...input, [field]: target }));
      return { ...started, envelope: { ...started.envelope, device: projection, owner } };
    }
    if (operation === "appLogInspect") return await runNative(operation, (method) => method());
    if (operation === "appLogDoctor") {
      const target = input.appBundleId === undefined ? undefined : await pinPackage(input.appBundleId, operation);
      return await runNative(operation, (method) => method({ ...input, appBundleId: target }));
    }
    const appId = operation === "perfProfileReport" && input.appId === undefined
      ? undefined : await pinPackage(input.appId, operation);
    if (operation === "perfProfileReport" && appId && input.profile?.kind === "simpleperf" && input.profile.packageName !== appId) {
      throw createError("INVALID_ARGS", "The Simpleperf profile belongs to another app.", { dispatched: "no" });
    }
    return await runNative(operation, (method) => method({ ...input, appId }));
  }

  return Object.fromEntries(operations.filter((operation) => facts[operation]?.available)
    .map((operation) => [operation, (input) => invoke(operation, input)]));
}
