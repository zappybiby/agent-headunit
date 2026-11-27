const keyboardWindow = "com.google.android.projection.gearhead:TouchInputMethod";
const mobileScrollDurationMs = 300;
const minimumGestureDurationMs = 16;

function rect(bounds) {
  const [x, y, right, bottom] = bounds;
  return { x, y, width: right - x, height: bottom - y };
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  if (width > 0 && height > 0) return { x, y, width, height };
}

function area(box) { return box.width * box.height; }

function contains(box, x, y) {
  return box.x <= x && x < box.x + box.width && box.y <= y && y < box.y + box.height;
}

function scrollContainer(scene, direction, requested, focused, keyboard) {
  const axis = direction === "up" || direction === "down" ? "vertical" : "horizontal";
  const candidates = scene.nodes.flatMap((node) => {
    if (!node.enabled || !node.carScrollBounds || node.display === keyboard?.id) return [];
    return [{ node, box: rect(node.carScrollBounds) }];
  });
  if (requested) {
    // A capture may precede a keyboard or panel layout change. Use only the part that still receives touch.
    const matches = candidates.flatMap(({ box }) => {
      const shared = intersection(box, requested);
      return shared && area(shared) === Math.min(area(box), area(requested)) ? [shared] : [];
    });
    matches.sort((a, b) => area(b) - area(a));
    return matches[0];
  }
  const suitable = candidates.filter(({ node }) => (node.reportedScrollAxis ?? node.scrollAxis) === axis);
  suitable.sort((a, b) => Number(b.node.display === focused?.id) - Number(a.node.display === focused?.id)
    || area(b.box) - area(a.box));
  return suitable[0]?.box;
}

export function bindProjectedScroll(readScene, performScroll, upstream, createError) {
  return async ({ direction, options }, signal) => {
    const scene = await readScene(signal);
    signal.throwIfAborted();
    const keyboard = scene.displays.find((panel) => panel.carWindow === keyboardWindow);
    const focused = scene.displays.find((panel) => panel.appFocused && panel.id !== keyboard?.id);
    const container = scrollContainer(scene, direction, options.containerRect, focused, keyboard);
    if (options.containerRect && !container) {
      throw createError("COMMAND_FAILED", "The selected projected scroll surface changed. Capture a new snapshot and retry.", {
        dispatched: "no",
      });
    }
    let viewport = !container && focused ? intersection(rect(focused.carBounds), scene.viewport) : scene.viewport;
    viewport ??= scene.viewport;
    let keyboardEvidence;
    const keyboardRect = keyboard && rect(keyboard.carBounds);
    if (keyboardRect && (!container || intersection(container, keyboardRect))) {
      const clip = upstream.clipScrollViewportAboveKeyboard(viewport, keyboardRect);
      if (clip.kind === "occluded") {
        throw upstream.scrollKeyboardOccludesSurfaceError(direction, { ...clip, viewportHeight: viewport.height });
      }
      if (clip.kind === "avoided") {
        viewport = clip.viewport;
        keyboardEvidence = { keyboardAvoided: true, keyboardMinY: clip.keyboardMinY };
      }
    }
    const lane = container && intersection(container, viewport);
    if (container && !lane) {
      throw createError("COMMAND_FAILED", "The selected projected scroll surface is covered.", { dispatched: "no" });
    }
    function planWithin(frame, target) {
      const relative = upstream.buildScrollGesturePlan({ direction, amount: options.amount, pixels: options.pixels,
        referenceWidth: frame.width, referenceHeight: frame.height,
        container: target && { ...target, x: target.x - frame.x, y: target.y - frame.y } });
      return { ...relative, x1: relative.x1 + frame.x, x2: relative.x2 + frame.x,
        y1: relative.y1 + frame.y, y2: relative.y2 + frame.y };
    }
    let plan = planWithin(viewport, lane);
    if (lane && !(contains(lane, plan.x1, plan.y1) && contains(lane, plan.x2, plan.y2))) {
      // The stock planner may abandon a container inside the outer screen padding. A projected rail can own that area.
      plan = planWithin(lane);
    }
    const frame = lane ?? viewport;
    if (!contains(frame, plan.x1, plan.y1) || !contains(frame, plan.x2, plan.y2) ||
        (plan.x1 === plan.x2 && plan.y1 === plan.y2)) {
      throw createError("COMMAND_FAILED", "The projected scroll surface is too small to swipe.", { dispatched: "no" });
    }
    const durationMs = Math.max(options.durationMs ?? mobileScrollDurationMs, minimumGestureDurationMs);
    const backend = await performScroll(plan, durationMs, options.releaseBehavior, signal, upstream);
    return { report: { ...plan, ...keyboardEvidence, backend, distance: plan.pixels, durationMs }, pixels: plan.pixels,
      midpoint: { x: (plan.x1 + plan.x2) / 2, y: (plan.y1 + plan.y2) / 2 } };
  };
}
