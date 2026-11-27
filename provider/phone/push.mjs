const packageName = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;

export function bindPhonePush({ bindNative, createError }) {
  return async (input) => {
    const { appId, payload } = input;
    if (typeof appId !== "string" || !packageName.test(appId)) {
      throw createError("INVALID_ARGS", "Specify the Android package for push.", { dispatched: "no" });
    }
    const receiver = typeof payload?.receiver === "string" ? payload.receiver.trim() : "";
    if (receiver) {
      const [owner, name, extra] = receiver.split("/");
      // Android resolves an explicit component before applying the implicit package filter.
      if (owner !== appId || !name || /[\s\u0000-\u001f\u007f]/u.test(name) || extra !== undefined) {
        throw createError("INVALID_ARGS", "The push receiver must name a component in the selected Android package.",
          { dispatched: "no" });
      }
    }
    return await bindNative(({ operations, facts }) => {
      const owner = facts.operations.sendPushNotification;
      if (!owner?.available || typeof operations.sendPushNotification !== "function") {
        throw createError("UNSUPPORTED_OPERATION", owner?.hint ?? "The projecting phone cannot send a push broadcast.", {
          reason: owner?.reason ?? "unsupported-platform-leaf", dispatched: "no",
        });
      }
      return operations.sendPushNotification(input);
    });
  };
}
