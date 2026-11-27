import assert from "node:assert/strict";
import test from "node:test";
import { bindReceiverAudioOperations, receiverAudioFacts } from "./receiver-audio.mjs";

test("starts Windows audio only after rechecking the receiver and recovers only its own probe", async () => {
  const projection = { id: "pair", family: "android", kind: "emulator", target: "mobile" };
  const owner = { kind: "provider", provider: "headunit", instance: "local" };
  const envelope = { resourceKind: "audio-probe", device: projection, owner };
  const calls = [];
  const bind = (live, verifyEmulatorReceiver) => bindReceiverAudioOperations({
    facts: receiverAudioFacts(undefined, live, true),
    projection, owner, verifyEmulatorReceiver,
    createError: (code, message) => Object.assign(new Error(message), { code }),
    emulatorCapture: {
      audioProbeStart: async () => { calls.push("start"); },
      audioProbeCleanup: async (input) => { calls.push(input.envelope); },
    },
  });

  const changed = bind(true, async () => { throw new Error("Receiver changed"); });
  await assert.rejects(changed.audioProbeStart({}), /Receiver changed/);
  assert.deepEqual(calls, []);

  await bind(true, async () => { calls.push("verify"); }).audioProbeStart({});
  const recovery = bind(false);
  assert.equal(recovery.audioProbeStart, undefined);
  await assert.rejects(recovery.audioProbeCleanup({
    envelope: { ...envelope, device: { ...projection, id: "other pair" } },
  }), { code: "INVALID_ARGS" });
  await recovery.audioProbeCleanup({ envelope });
  assert.deepEqual(calls, ["verify", "start", envelope]);
});
