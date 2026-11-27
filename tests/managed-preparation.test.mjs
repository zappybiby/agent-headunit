import assert from "node:assert/strict";
import test from "node:test";
import { managedPreparation } from "../provider/index.mjs";

const host = { createError: (code, message) => Object.assign(new Error(message), { code }) };

test("managed preparation allows cold boot and caps projection verification at the lease deadline", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const preparation = managedPreparation({ deadline: Date.now() + 300000 }, host);
  t.after(() => preparation.finish());
  preparation.enter("starting the emulators and connecting Android Auto");
  t.mock.timers.tick(75001);
  assert.equal(preparation.signal.aborted, false);
  t.mock.timers.tick(164999);
  preparation.enter("checking the active projection");
  t.mock.timers.tick(60000);
  assert.throws(() => preparation.enter("starting the projection driver"), {
    code: "COMMAND_FAILED",
    message: "Open Headunit reached its allocation deadline while checking the active projection.",
  });
});

test("expired allocation refuses before claiming and request cancellation keeps its original reason", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const expired = managedPreparation({ deadline: Date.now() - 1 }, host);
  t.after(() => expired.finish());
  assert.throws(() => expired.enter("claiming the configured emulator pair"), /allocation deadline while claiming/);
  const parent = new AbortController();
  const preparation = managedPreparation({ deadline: Date.now() + 300000, signal: parent.signal }, host);
  t.after(() => preparation.finish());
  preparation.enter("starting the emulators and connecting Android Auto");
  const canceled = new Error("caller canceled");
  parent.abort(canceled);
  assert.equal(preparation.signal.reason, canceled);
  assert.throws(() => preparation.enter("checking the active projection"), (error) => error === canceled);
});

test("successful preparation leaves later commands free of its deadline signal", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const preparation = managedPreparation({ deadline: Date.now() + 300000 }, host);
  preparation.finish();
  t.mock.timers.tick(300001);
  assert.equal(preparation.signal.aborted, false);
});
