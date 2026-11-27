import assert from "node:assert/strict";
import test from "node:test";
import { gestureTimeline } from "./gesture-timeline.mjs";

const pause = (duration = 0) => ({ type: "pause", duration });
const move = (x, y = 20) => ({ type: "pointerMove", duration: 0, x, y });
const down = { type: "pointerDown", button: 0 };
const up = { type: "pointerUp", button: 0 };
const pointer = (id, actions) => ({ type: "pointer", id, parameters: { pointerType: "touch" }, actions });

test("the projection timeline retains stock Android sample and transition times for a maximum-duration transform", () => {
  const paths = [0, 1].map((index) => {
    const startX = index === 0 ? 100 : 200;
    const samples = Array.from({ length: 625 }, (_, sample) => [
      pause(sample === 0 ? 8 : 16), move(startX + (sample + 1) / 10),
    ]).flat();
    const transitions = index === 0 ? [down, pause(8), pause()] : [pause(), pause(8), down];
    const releases = index === 0 ? [pause(), pause(8), up] : [up, pause(8), pause()];
    return pointer(String(index), [move(startX), ...transitions, ...samples, ...releases]);
  });
  const plan = gestureTimeline(paths);
  assert.equal(plan.durationMs, 10008);
  assert.equal(plan.frames.length, 628);
  assert.deepEqual(plan.frames.slice(0, 3), [
    { atMs: 0, events: [{ id: "0", phase: "down", x: 100, y: 20 }] },
    { atMs: 8, events: [{ id: "1", phase: "down", x: 200, y: 20 }] },
    { atMs: 16, events: [{ id: "0", phase: "move", x: 100.1, y: 20 }, { id: "1", phase: "move", x: 200.1, y: 20 }] },
  ]);
  assert.deepEqual(plan.frames.slice(-2), [
    { atMs: 10000, events: [{ id: "0", phase: "move", x: 162.5, y: 20 },
      { id: "1", phase: "move", x: 262.5, y: 20 }, { id: "1", phase: "up", x: 262.5, y: 20 }] },
    { atMs: 10008, events: [{ id: "0", phase: "up", x: 162.5, y: 20 }] },
  ]);
});

test("ordinary W3C multi-touch keeps any simultaneous contact order authored by the caller", () => {
  const plan = gestureTimeline([
    pointer("first", [move(20), down, pause(40), up]),
    pointer("second", [move(80), down, pause(40), up]),
  ]);
  assert.deepEqual(plan.frames, [
    { atMs: 0, events: [{ id: "first", phase: "down", x: 20, y: 20 },
      { id: "second", phase: "down", x: 80, y: 20 }] },
    { atMs: 40, events: [{ id: "first", phase: "up", x: 20, y: 20 },
      { id: "second", phase: "up", x: 80, y: 20 }] },
  ]);
});
