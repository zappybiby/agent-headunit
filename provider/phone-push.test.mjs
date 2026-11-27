import assert from "node:assert/strict";
import test from "node:test";
import { bindPhonePush } from "./phone-push.mjs";

test("push preserves stock delivery and refuses a receiver in another phone app", async () => {
  const dispatched = [];
  const push = bindPhonePush({
    bindNative: (call) => call({
      operations: { sendPushNotification: async (input) => { dispatched.push(input); } },
      facts: { operations: { sendPushNotification: { available: true } } },
    }),
    createError: (code, message, details) => Object.assign(new Error(message), { code, details }),
  });
  const appId = "lab.headunit.fixture";
  await assert.rejects(push({ appId, payload: { receiver: "org.other.app/.Receiver" } }),
    { code: "INVALID_ARGS", details: { dispatched: "no" } });
  const implicit = { appId, payload: { action: "lab.headunit.fixture.TEST", extras: { message: "hello" } } };
  const explicit = { ...implicit, payload: { ...implicit.payload, receiver: appId + "/.Receiver" } };
  await push(implicit);
  await push(explicit);
  assert.deepEqual(dispatched, [implicit, explicit]);
});
