import assert from "node:assert/strict";
import test from "node:test";
import { bindReceiverOrientationOperations } from "../../../provider/receiver/orientation.mjs";

const projection = "com.andrerinas.headunitrevived/com.andrerinas.openheadunit.aap.AapProjectionActivity";
const home = "com.android.launcher3/.Launcher";
const displayArea = (id, lines) => `Display #${id} (activities from top to bottom):\n${lines.join("\n")}`;
const resumed = (field, component) => `    ${field}ActivityRecord{a87 u0 ${component} t6}`;

function receiver(activities) {
  const available = { available: true };
  const facts = { setOrientation: available, unlockOrientation: available };
  const events = [];
  let rotation = 0;
  let mode = "free";
  const reply = (stdout) => ({ exitCode: 0, stdout });
  const dimensions = () => rotation === 1 ? [1920, 1080] : [1080, 1920];

  const operations = bindReceiverOrientationOperations({
    facts, receiverDevice: { id: "receiver" }, phoneSerial: "phone", scope: { signal: new AbortController().signal },
    createError: (code, message) => Object.assign(new Error(message), { code }),
    bindNative: (callback) => callback({ facts: { operations: facts }, operations: {
      async setOrientation({ rotation: requested }) {
        assert.equal(requested, "landscape-left");
        events.push("lock");
        rotation = 1;
        mode = "lock 1";
      },
      async unlockOrientation() {
        events.push("free");
        rotation = 0;
        mode = "free";
      },
    } }),
    async runAdbShell(device, args) {
      assert.equal(device.id, "receiver");
      if (args[0] === "run-as") return reply("<map />");
      if (args[1] === "activity") return reply(activities);
      if (args[1] === "user-rotation") return reply(mode);
      assert.deepEqual(args, ["dumpsys", "display"]);
      return reply(`mOverrideDisplayInfo=DisplayInfo{"receiver", displayId 0, real ${dimensions().join(" x ")}, rotation ${rotation}, state ON}`);
    },
    async readLayout() {
      const [width, height] = dimensions();
      return { serial: "phone", receiver: "receiver", viewport: { width, height }, displays: [{}] };
    },
    updateLayout: ({ viewport }) => events.push(viewport),
  });

  return { operations, events };
}

test("rotates a primary projection reported with topResumedActivity and updates geometry after unlock", async () => {
  const { operations, events } = receiver(displayArea(0, [resumed("topResumedActivity=", projection)]));
  assert.deepEqual(await operations.setOrientation({ rotation: "landscape-left" }), { orientation: "landscape-left" });
  await operations.unlockOrientation();
  assert.deepEqual(events, ["lock", { width: 1920, height: 1080 }, "free", { width: 1080, height: 1920 }]);
});

test("does not rotate an inactive receiver when another app is top resumed", async () => {
  const primary = displayArea(0, [resumed("mResumedActivity: ", projection), resumed("topResumedActivity=", home)]);
  const secondary = displayArea(8, [resumed("topResumedActivity=", projection)]);
  const { operations, events } = receiver(`${primary}\n${secondary}`);
  await assert.rejects(operations.setOrientation({ rotation: "landscape-left" }), {
    code: "UNSUPPORTED_OPERATION", message: /not on its primary display/,
  });
  assert.deepEqual(events, []);
});
