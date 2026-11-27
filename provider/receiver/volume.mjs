const buttons = ["volumeUp", "volumeDown", "mute"];
const unavailable = Object.freeze({ available: false, reason: "owner-capability-missing" });

export function receiverVolumeFacts(nativeReceiverFacts, live) {
  return Object.fromEntries(buttons.map((button) => [button,
    live ? nativeReceiverFacts?.operations?.[button] ?? unavailable : unavailable,
  ]));
}

export function bindReceiverVolumeOperations({ facts, bindNative, createError }) {
  return Object.fromEntries(buttons.filter((button) => facts[button]?.available).map((button) => [button,
    (input) => bindNative(({ operations, facts: current }) => {
      const fact = current.operations[button];
      if (!fact?.available || typeof operations[button] !== "function") {
        throw createError("UNSUPPORTED_OPERATION", fact?.hint ?? `The receiver does not support ${button}.`, {
          reason: fact?.reason ?? unavailable.reason, dispatched: "no",
        });
      }
      return operations[button](input);
    }),
  ]));
}
