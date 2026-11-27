const inactive = Object.freeze({ available: false, reason: "owner-capability-missing" });
const available = Object.freeze({ available: true });
const captureOperations = ["audioProbeStart", "audioProbeReattach", "audioProbeCleanup"];
const unavailableQuery = Object.freeze({ available: false, reason: "unsupported-provider-mode" });

/** Stock receiver audio is host system output, with the native runtime's host and device gates. */
export function receiverAudioFacts(nativeReceiverFacts, live, emulatorCapture = false) {
  return Object.fromEntries([
    ...captureOperations.map((operation) => [operation,
      operation === "audioProbeStart" && !live
        ? inactive : emulatorCapture ? available : nativeReceiverFacts?.operations?.[operation] ?? inactive,
    ]),
    ["audioProbeQuery", unavailableQuery],
  ]);
}

function ownsEnvelope(envelope, projection, owner) {
  return envelope?.resourceKind === "audio-probe" &&
    envelope.device?.id === projection.id && envelope.device.family === projection.family &&
    envelope.device.kind === projection.kind && envelope.device.target === projection.target &&
    envelope.owner?.kind === owner.kind && envelope.owner.provider === owner.provider &&
    envelope.owner.instance === owner.instance;
}

/** bindNative must bind only the selected receiver, and dispose its binding after the call. */
export function bindReceiverAudioOperations({
  facts, bindNative, projection, owner, deviceIdentity, createError, emulatorCapture, verifyEmulatorReceiver,
}) {
  function runNative(operation, callback) {
    return bindNative((binding) => {
      const fact = binding.facts.operations[operation];
      const method = binding.operations[operation];
      if (!fact?.available || typeof method !== "function") {
        throw createError("UNSUPPORTED_OPERATION", fact?.hint ?? `The receiver does not support ${operation}.`, {
          reason: fact?.reason ?? inactive.reason, dispatched: "no",
        });
      }
      return callback(method, binding);
    });
  }

  async function start(input) {
    if (emulatorCapture) {
      await verifyEmulatorReceiver();
      return emulatorCapture.audioProbeStart(input);
    }
    const result = await runNative("audioProbeStart", (method) => method(input));
    return { ...result, envelope: { ...result.envelope, device: projection, owner } };
  }

  async function recover(operation, input) {
    const { envelope } = input;
    if (!ownsEnvelope(envelope, projection, owner)) {
      throw createError("INVALID_ARGS", "The audio probe belongs to another projection or runtime.", { dispatched: "no" });
    }
    if (emulatorCapture) return emulatorCapture[operation](input);
    return await runNative(operation, (method, binding) => method({
      ...input, envelope: { ...envelope, device: deviceIdentity(binding.device), owner: binding.owner },
    }));
  }

  const operations = {
    audioProbeStart: start,
    audioProbeReattach: (input) => recover("audioProbeReattach", input),
    audioProbeCleanup: (input) => recover("audioProbeCleanup", input),
  };
  return Object.fromEntries(captureOperations.filter((operation) => facts[operation]?.available)
    .map((operation) => [operation, operations[operation]]));
}
