import assert from "node:assert/strict";
import test from "node:test";
import { bindProjectedScroll } from "../provider/projected-scroll.mjs";
import { startDriver } from "../provider/driver.mjs";

const viewport = { x: 0, y: 0, width: 800, height: 480 };
const vertical = { display: 1, enabled: true, scrollAxis: "vertical", carScrollBounds: [10, 25, 490, 400] };
const sidebar = { display: 2, enabled: true, scrollAxis: "vertical", carScrollBounds: [510, 30, 770, 300] };
const horizontal = { display: 1, enabled: true, reportedScrollAxis: "horizontal", carScrollBounds: [20, 300, 450, 365] };
const scene = { serial: "fixture-phone", viewport, nodes: [vertical, sidebar, horizontal],
  displays: [{ id: 1, carBounds: [0, 0, 500, 480], appFocused: true }, { id: 2, carBounds: [500, 0, 800, 480] }] };
const createError = (code, message, details) => Object.assign(new Error(message), { code, details });

test("uses the observed refresh container and the horizontal container for horizontal scroll", async () => {
  const controller = new AbortController();
  const plans = [], touches = [];
  const scroll = bindProjectedScroll(async () => scene, async (...args) => {
    touches.push(args);
    return "projected-touch";
  }, {
    buildScrollGesturePlan(input) {
      plans.push(input);
      const { direction, container: { x, y }, referenceWidth, referenceHeight } = input;
      return { direction, referenceWidth, referenceHeight, x1: x + 20, y1: y + 20,
        x2: x + (direction === "right" ? 10 : 20), y2: y + (direction === "right" ? 20 : 100), pixels: 10 };
    },
  }, createError);
  const sidebarRect = { x: 510, y: 30, width: 260, height: 270 };
  await scroll({ direction: "up", options: { amount: 0.4, containerRect: sidebarRect,
    durationMs: 1200, releaseBehavior: "controlled" } }, controller.signal);
  assert.deepEqual(plans[0], { direction: "up", amount: 0.4, pixels: undefined,
    referenceWidth: 800, referenceHeight: 480, container: sidebarRect });
  assert.equal(touches[0][0].x1, 530);
  assert.deepEqual(touches[0].slice(1, 4), [1200, "controlled", controller.signal]);

  const result = await scroll({ direction: "right", options: { pixels: 10, releaseBehavior: "inertial" } }, controller.signal);
  assert.deepEqual(plans[1].container, { x: 20, y: 300, width: 430, height: 65 });
  assert.equal(plans[1].pixels, 10);
  assert.deepEqual(touches[1].slice(1, 4), [300, "inertial", controller.signal]);
  assert.equal(result.pixels, 10);
  assert.deepEqual(result.midpoint, { x: 35, y: 320 });
});

test("refuses a keyboard-covered viewport before planning or touching", async () => {
  const keyboard = { id: 9, carWindow: "com.google.android.projection.gearhead:TouchInputMethod", carBounds: [0, 10, 800, 480] };
  const refusal = createError("COMMAND_FAILED", "keyboard occludes scroll", { reason: "scroll_keyboard_occludes_surface" });
  const scroll = bindProjectedScroll(async () => ({ ...scene, displays: [keyboard], nodes: [] }),
    () => assert.fail("the keyboard received the scroll"), {
      clipScrollViewportAboveKeyboard: (actual, keyboardBounds) => {
        assert.deepEqual(actual, viewport);
        assert.deepEqual(keyboardBounds, { x: 0, y: 10, width: 800, height: 470 });
        return { kind: "occluded", keyboardMinY: 10, visibleHeight: 0 };
      },
      scrollKeyboardOccludesSurfaceError: () => refusal,
      buildScrollGesturePlan: () => assert.fail("no swipe geometry is usable"),
    }, createError);
  await assert.rejects(scroll({ direction: "down", options: {} }, new AbortController().signal), (error) => error === refusal);
});

test("refuses a vanished captured scroll container before touching a different panel", async () => {
  const signal = new AbortController().signal;
  const scroll = bindProjectedScroll(async () => ({ ...scene, nodes: [vertical] }),
    () => assert.fail("the other panel received the scroll"), {}, createError);
  await assert.rejects(scroll({ direction: "up", options: { containerRect: { x: 510, y: 30, width: 260, height: 270 } } }, signal),
    { code: "COMMAND_FAILED", details: { dispatched: "no" } });
});

test("passes stock Android scroll samples to the projected touch guard", async () => {
  const stopped = new Error("fixture stops at the guard");
  const signal = new AbortController().signal;
  const driver = await startDriver(scene, async ({ op, frames }) => {
    assert.equal(op, "gesturePlan");
    assert.deepEqual(frames, [
      { atMs: 0, events: [{ id: "scroll", phase: "down", x: 50, y: 300 }] },
      { atMs: 260, events: [{ id: "scroll", phase: "move", x: 50, y: 100 }] },
      { atMs: 300, events: [{ id: "scroll", phase: "move", x: 50, y: 98 }, { id: "scroll", phase: "up", x: 50, y: 98 }] },
    ]);
    throw stopped;
  }, {});
  try {
    const lease = await fetch(driver.endpoint + "/session", { method: "POST", headers: driver.headers });
    assert.equal(lease.status, 200);
    const upstream = {
      buildGesturePlan: (input, actualViewport, platform) => {
        assert.deepEqual(actualViewport, viewport);
        assert.equal(platform, "android");
        assert.deepEqual(input, { intent: "pan", origin: { x: 50, y: 300 }, delta: { x: 0, y: -202 }, durationMs: 300 });
        return {};
      },
      lowerAndroidTouchPlan: ({ releaseBehavior }) => {
        assert.equal(releaseBehavior, "controlled");
        return { pointers: [{ samples: [
          { offsetMs: 0, point: { x: 50, y: 300 } },
          { offsetMs: 260, point: { x: 50, y: 100 } },
          { offsetMs: 300, point: { x: 50, y: 98 } },
        ] }] };
      },
    };
    await assert.rejects(driver.performScroll({ x1: 50, y1: 300, x2: 50, y2: 98 }, 300, "controlled", signal, upstream),
      (error) => error === stopped);
  } finally { await driver.cleanup(); }
});
