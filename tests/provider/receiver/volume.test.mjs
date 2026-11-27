import test from "node:test";
import assert from "node:assert/strict";
import { bindReceiverVolumeOperations, receiverVolumeFacts } from "../../../provider/receiver/volume.mjs";

test("receiver volume operations fail closed when the receiver cannot handle them", async () => {
  const yes = { available: true };
  const no = { available: false, reason: "unsupported-device-kind" };
  const facts = receiverVolumeFacts({ operations: { volumeUp: yes, volumeDown: no, mute: yes } }, true);
  assert.deepEqual(facts.volumeDown, no);
  assert.equal(receiverVolumeFacts({ operations: { mute: yes } }, false).mute.available, false);
  let called = false;
  const operations = bindReceiverVolumeOperations({
    facts,
    bindNative: async (action) => action({ facts: { operations: { mute: no } }, operations: {
      mute: async () => { called = true; },
    } }),
    createError: (code, message, details) => Object.assign(new Error(message), { code, details }),
  });
  assert.equal(operations.volumeDown, undefined);
  await assert.rejects(operations.mute({}), { code: "UNSUPPORTED_OPERATION", details: { reason: "unsupported-device-kind", dispatched: "no" } });
  assert.equal(called, false);
});
