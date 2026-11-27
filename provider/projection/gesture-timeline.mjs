// Convert W3C touch actions to display-independent, timed contact events.
export const GESTURE_LIMITS = Object.freeze({
  sources: 5, ticks: 2048, durationMs: 60000, frames: 4096, events: 16384,
  sampleIntervalMs: 16,
});

export class GestureTimelineError extends Error {
  constructor(message) { super(message); this.name = "GestureTimelineError"; }
}

function invalid(message) { throw new GestureTimelineError(message); }
function duration(step) {
  const value = step.duration ?? 0;
  if (!Number.isInteger(value) || value < 0 || value > GESTURE_LIMITS.durationMs)
    invalid("Action duration must be a nonnegative integer within the gesture limit.");
  return value;
}
function coordinate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid("Touch coordinates must be finite numbers.");
  return value;
}

/**
 * Each event is {id, phase: 'down'|'move'|'up', x, y} in car coordinates.
 * Events at the same time retain W3C tick and source order. A contact cannot
 * survive the call; the executor owns cancellation after dispatch starts.
 */
export function gestureTimeline(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > GESTURE_LIMITS.sources)
    invalid("Expected one to five touch pointer sources.");
  const ids = new Set();
  const pointers = sources.map((source) => {
    if (!source || source.type !== "pointer" || source.parameters?.pointerType !== "touch" ||
        typeof source.id !== "string" || !source.id || source.id.length > 128 || ids.has(source.id) ||
        !Array.isArray(source.actions) || source.actions.length > GESTURE_LIMITS.ticks)
      invalid("Expected uniquely named touch pointer sources with bounded actions.");
    ids.add(source.id);
    return { id: source.id, actions: source.actions, x: 0, y: 0, down: false, used: false };
  });
  const ticks = Math.max(...pointers.map((p) => p.actions.length));
  if (!ticks) invalid("Expected at least one touch action.");
  const frames = new Map();
  let count = 0, now = 0;
  function emit(atMs, event, tick, order) {
    let events = frames.get(atMs);
    if (!events) {
      if (frames.size >= GESTURE_LIMITS.frames) invalid("Gesture exceeds the frame limit.");
      frames.set(atMs, events = []);
    }
    if (++count > GESTURE_LIMITS.events) invalid("Gesture exceeds the event limit.");
    events.push({ event, tick, order });
  }
  for (let tick = 0; tick < ticks; tick++) {
    const moves = [];
    let tickDuration = 0;
    for (const [order, p] of pointers.entries()) {
      const step = p.actions[tick] ?? { type: "pause" };
      if (!step || typeof step !== "object") invalid("Invalid touch action.");
      if (step.type === "pause") {
        tickDuration = Math.max(tickDuration, duration(step));
      } else if (step.type === "pointerMove") {
        const ms = duration(step);
        tickDuration = Math.max(tickDuration, ms);
        const origin = step.origin ?? "viewport";
        if (origin !== "viewport" && origin !== "pointer") invalid("Touch moves require viewport or pointer origin.");
        const x = coordinate(step.x) + (origin === "pointer" ? p.x : 0);
        const y = coordinate(step.y) + (origin === "pointer" ? p.y : 0);
        coordinate(x); coordinate(y);
        moves.push({ p, fromX: p.x, fromY: p.y, x, y, ms, active: p.down, order });
        p.x = x; p.y = y;
      } else if (step.type === "pointerDown" || step.type === "pointerUp") {
        if (step.button !== 0 || (step.type === "pointerDown") === p.down)
          invalid("Touch contacts must use button zero and have balanced down and up actions.");
        p.down = step.type === "pointerDown";
        p.used = true;
        emit(now, { id: p.id, phase: p.down ? "down" : "up", x: p.x, y: p.y }, tick, order);
      } else invalid("Unsupported touch action.");
    }
    if (now + tickDuration > GESTURE_LIMITS.durationMs) invalid("Gesture exceeds the duration limit.");
    for (const move of moves) {
      if (!move.active) continue;
      const offsets = [];
      for (let ms = GESTURE_LIMITS.sampleIntervalMs; ms < move.ms; ms += GESTURE_LIMITS.sampleIntervalMs) offsets.push(ms);
      offsets.push(move.ms);
      for (const offset of offsets) {
        const progress = move.ms ? offset / move.ms : 1;
        emit(now + offset, { id: move.p.id, phase: "move",
          x: coordinate(move.fromX + (move.x - move.fromX) * progress),
          y: coordinate(move.fromY + (move.y - move.fromY) * progress) }, tick, move.order);
      }
    }
    now += tickDuration;
  }
  if (pointers.some((p) => p.down || !p.used)) invalid("Every touch pointer must complete a contact.");
  return { durationMs: now, frames: [...frames].sort((a, b) => a[0] - b[0]).map(([atMs, events]) => ({
    atMs, events: events.sort((a, b) => a.tick - b.tick || a.order - b.order).map((entry) => entry.event),
  })) };
}
