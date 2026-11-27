import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { GestureTimelineError, gestureTimeline } from "./gesture-timeline.mjs";
import { runProjectedTouch } from "./projected-touch.mjs";

function xmlValue(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}

function nodeBounds(node) {
  if (node.actions.includes("press") && node.carPressBounds) return node.carPressBounds;
  return node.carScrollBounds ?? node.carBounds;
}

export function pageSource(scene, onNode, { raw = false } = {}) {
  const children = new Map();
  for (const node of scene.nodes) {
    const siblings = children.get(node.parent) ?? [];
    siblings.push(node);
    children.set(node.parent, siblings);
  }
  function hasSeparateContent(node, label) {
    if (node.actions.length || node.editable || node.checkable || node.longClickable) return true;
    if ([node.text, node.description].some((value) => value && value !== label)) return true;
    return children.get(node.ref)?.some((child) => hasSeparateContent(child, label)) ?? false;
  }
  function descendantLabel(node) {
    const labels = new Set();
    function visit(child) {
      if (child.actions.length || child.editable || child.checkable || child.longClickable) return;
      for (const value of [child.text, child.description]) if (value) labels.add(value);
      for (const nested of children.get(child.ref) ?? []) visit(nested);
    }
    for (const child of children.get(node.ref) ?? []) visit(child);
    return labels.size === 1 ? labels.values().next().value : "";
  }
  function passive(node) {
    return node.clickable === false && !node.actions.length && !node.editable && !node.checkable &&
      !node.longClickable && !node.scrollAxis && !node.focusable && !node.focused;
  }
  function repeatsCaption(node, owner) {
    if (!owner || !passive(node) || node.id || node.roleDescription || node.stateDescription ||
        node.heading || node.hint || node.tooltip || node.display !== owner.control.display ||
        node.window !== owner.control.window) return false;
    const names = [node.text, node.description].filter(Boolean);
    if (!names.length || !names.every((name) => name === owner.name)) return false;
    const [x, y, right, bottom] = node.carBounds;
    const [left, top, endX, endY] = owner.bounds;
    return x >= left && y >= top && right <= endX && bottom <= endY;
  }
  function captionText(node, owner) {
    for (const child of children.get(node.ref) ?? []) {
      if (!passive(child)) continue;
      if (child.text === owner.name && repeatsCaption(child, owner)) return child.text;
      const nested = captionText(child, owner);
      if (nested) return nested;
    }
  }
  function render(node, owner) {
    if (repeatsCaption(node, owner)) {
      return (children.get(node.ref) ?? []).map((child) => render(child, owner)).join("");
    }
    onNode?.(node);
    const [left, top, right, bottom] = nodeBounds(node);
    const clickable = node.actions.includes("press");
    const disabledControl = !raw && node.clickable === true && node.enabled === false;
    const scrollable = node.actions.some((op) => op.startsWith("scroll-"));
    let roleClass = { tab: "Tab", "list item": "ListItem" }[node.roleDescription?.toLowerCase()];
    // Compose can expose a click on a parent and its button role on a passive child with the same bounds.
    if (!roleClass && clickable && node.className === "android.view.View" &&
        children.get(node.ref)?.some((child) => child.className === "android.widget.Button" &&
          !child.actions.length && child.carBounds.every((v, i) => v === node.carBounds[i]))) {
      roleClass = "android.widget.Button";
    }
    let scrollClass;
    if (scrollable && node.carScrollBounds && ["android.view.View", "android.view.ViewGroup"].includes(node.className)) {
      if (node.scrollAxis === "vertical") scrollClass = "android.widget.ScrollView";
      if (node.scrollAxis === "horizontal") scrollClass = "android.widget.HorizontalScrollView";
    }
    const publishedClass = roleClass ?? scrollClass;
    let description = node.description ||
      (!node.text && (clickable || disabledControl || roleClass) ? descendantLabel(node) : "");
    if (!node.text?.trim() && (!description?.trim() || description.trim().toLowerCase() === "image")) {
      const fallback = [node.clickLabel, node.tooltip].map((value) => value?.trim())
        .find((value) => value && value.toLowerCase() !== "image");
      if (fallback) description = fallback;
    }
    const name = node.text || description;
    const captionBounds = disabledControl ? node.carBounds : node.carPressBounds;
    const ownsCaption = !raw && (clickable || disabledControl) && !node.editable && name && captionBounds;
    const nextOwner = ownsCaption ? { control: node, name, bounds: captionBounds } : passive(node) ? owner : undefined;
    const text = ownsCaption && !node.text ? captionText(node, nextOwner) ?? node.text : node.text;
    const attrs = {
      class: publishedClass ?? node.className,
      "native-class": publishedClass ? node.className : undefined,
      package: node.packageName, "resource-id": node.id,
      text, "content-desc": description, clickable: node.clickable, enabled: node.enabled,
      "role-description": node.roleDescription,
      heading: node.heading || undefined, hint: node.hint || undefined, "hint-showing": node.showingHint,
      "state-description": node.stateDescription || undefined, tooltip: node.tooltip || undefined,
      "selection-start": node.selectionStart >= 0 ? node.selectionStart : undefined,
      "selection-end": node.selectionEnd >= 0 ? node.selectionEnd : undefined, password: node.password,
      displayed: true, focused: node.focused, selected: node.selected, checked: node.checked,
      checkable: node.checkable ?? typeof node.checked === "boolean", focusable: node.focusable,
      "long-clickable": node.longClickable, scrollable,
      "scroll-axis": scrollable && node.carScrollBounds ? node.reportedScrollAxis : undefined,
      editable: node.editable, bounds: "[" + left + "," + top + "][" + right + "," + bottom + "]",
    };
    const attributes = Object.entries(attrs).filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => key + '="' + xmlValue(value) + '"').join(" ");
    let nested = children.get(node.ref);
    if (roleClass && description && nested &&
        !nested.some((child) => hasSeparateContent(child, description))) nested = undefined;
    return nested ? "<node " + attributes + ">" + nested.map((child) => render(child, nextOwner)).join("") + "</node>"
      : "<node " + attributes + "/>";
  }
  return "<hierarchy>" + (children.get(null) ?? []).map((node) => render(node)).join("") + "</hierarchy>";
}

export class DriverError extends Error {
  constructor(kind, message, status = 400) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

function invalid(message) { throw new DriverError("invalid argument", message); }
function unsupported(message) { throw new DriverError("unsupported operation", message, 501); }
function contains(rect, x, y) { return rect && rect[0] <= x && x < rect[2] && rect[1] <= y && y < rect[3]; }

export function singleGesture(sequences) {
  if (!Array.isArray(sequences) || sequences.length !== 1) unsupported("Only one touch pointer is available.");
  const pointer = sequences[0];
  if (pointer?.type !== "pointer" || pointer.parameters?.pointerType !== "touch") invalid("Expected a touch pointer.");
  const sequence = pointer.actions;
  if (!Array.isArray(sequence) || sequence.length < 3) invalid("Expected a complete touch gesture.");
  const [start, down, ...rest] = sequence;
  const up = rest.pop();
  const point = (step) => {
    if (step?.type !== "pointerMove" || !Number.isFinite(step.x) || !Number.isFinite(step.y)
        || (step.origin && step.origin !== "viewport")) invalid("Invalid touch coordinate.");
    return { x: Math.round(step.x), y: Math.round(step.y) };
  };
  const from = point(start);
  if (down.type !== "pointerDown" || up.type !== "pointerUp" || down.button !== 0 || up.button !== 0) {
    invalid("Expected one complete pointer contact.");
  }
  let durationMs = 0;
  let timedHold = false;
  let to = from;
  let previousMove = start;
  const points = [from];
  for (const step of rest) {
    if (!Number.isFinite(step.duration) || step.duration < 0) invalid("Invalid touch duration.");
    durationMs += step.duration;
    if (step.type === "pointerMove") {
      to = point(step);
      timedHold ||= step.duration > 0 && step.x === previousMove.x && step.y === previousMove.y;
      previousMove = step;
      points.push(to);
    } else if (step.type === "pause") timedHold ||= step.duration > 0;
    else unsupported("This touch sequence needs multiple contacts.");
  }
  if (from.x === to.x && from.y === to.y) {
    if (points.some((p) => p.x !== from.x || p.y !== from.y)) unsupported("A returning drag needs a gesture path.");
    return durationMs ? { op: "longPress", ...from, durationMs } : { op: "tap", ...from };
  }
  if (timedHold) unsupported("A hold during a moving gesture requires the Open Headunit touch helper.");
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  let travelled = 0;
  for (const p of points) {
    const progress = ((p.x - from.x) * dx + (p.y - from.y) * dy) / length;
    if (Math.abs((p.x - from.x) * dy - (p.y - from.y) * dx) > length
        || progress < travelled - 1 || progress > length + 1) unsupported("Only straight swipes are available.");
    travelled = progress;
  }
  return { op: "swipe", from, to, durationMs: Math.max(1, durationMs) };
}

export async function startDriver(initial, call, touch, adopt) {
  const token = randomUUID(), id = randomUUID();
  let active = false;
  let scene = initial;
  let activeGesture;
  const rpc = (request, signal) => call({ ...request, serial: initial.serial }, signal);
  function requireSession() {
    if (!active) throw new Error("The Open Headunit driver session has ended.");
  }
  async function readScene(signal, includeScreenReader = false) {
    const observed = await rpc({ op: "snapshot", ...(includeScreenReader && { includeScreenReader }) }, signal);
    signal?.throwIfAborted();
    scene = observed;
    return observed;
  }
  function pointAction(actions) {
    try {
      const action = singleGesture(actions);
      if (action.op !== "swipe") return action;
    } catch (error) {
      if (!(error instanceof DriverError)) throw error;
    }
  }
  async function cancelGesture() {
    if (!activeGesture) return;
    const { controller, combined, result } = activeGesture;
    controller.abort();
    try { await result; }
    catch (error) { if (error !== combined.reason) throw error; }
  }
  async function executeFrames(frames, expectedTarget, signal) {
    if (activeGesture) throw new DriverError("invalid argument", "A projected gesture is already active.", 409);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const result = (async () => {
      const { plan } = await rpc({ op: "gesturePlan", frames, ...expectedTarget }, combined);
      return await runProjectedTouch(initial.serial, touch, plan, combined);
    })();
    activeGesture = { controller, combined, result };
    try {
      const status = await result;
      combined.throwIfAborted();
      if (status !== "success") throw new DriverError("unknown error", "The projected gesture ended before completion.");
    } finally {
      activeGesture = undefined;
    }
  }
  async function executeGesture(actions, expectedTarget, signal) {
    let frames;
    try { ({ frames } = gestureTimeline(actions)); }
    catch (error) { if (error instanceof GestureTimelineError) invalid(error.message); throw error; }
    return await executeFrames(frames, expectedTarget, signal);
  }
  async function performScroll(plan, durationMs, releaseBehavior, signal, upstream) {
    requireSession();
    signal.throwIfAborted();
    const from = { x: plan.x1, y: plan.y1 };
    const to = { x: plan.x2, y: plan.y2 };
    if (!touch) {
      await rpc({ op: "swipe", from, to, durationMs }, signal);
      return "projected-adb-swipe";
    }
    const pan = upstream.buildGesturePlan({ intent: "pan", origin: from,
      delta: { x: to.x - from.x, y: to.y - from.y }, durationMs }, scene.viewport, "android");
    const { pointers: [{ samples }] } = upstream.lowerAndroidTouchPlan({ ...pan, releaseBehavior });
    const frames = samples.map(({ offsetMs: atMs, point }, index) => {
      const event = (phase) => ({ id: "scroll", phase, ...point });
      return { atMs, events: index === 0 ? [event("down")] : index === samples.length - 1
        ? [event("move"), event("up")] : [event("move")] };
    });
    await executeFrames(frames, undefined, signal);
    return "projected-touch";
  }
  async function typeText(text, delayMs, fieldId, signal) {
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000)
      invalid("Text delay must be an integer between 0 and 10000 milliseconds.");
    const characters = delayMs > 0 ? Array.from(text) : [text];
    if (characters.length < 2) {
      await rpc({ op: "type", id: fieldId, text }, signal);
      return null;
    }
    if (text.includes("\b") && /[^\b]/u.test(text)) invalid("Send projected Backspace separately from other text.");
    const id = fieldId ?? (await rpc({ op: "field" }, signal)).field?.id;
    if (!id) throw new DriverError("no such element", "The projected text field no longer has focus.", 404);
    for (const [index, character] of characters.entries()) {
      if (index) await pause(delayMs, undefined, { signal });
      signal.throwIfAborted();
      await rpc({ op: "type", id, text: character }, signal);
    }
    return null;
  }
  async function route(method, url, body, signal) {
    if (method === "POST" && url === "/session") {
      if (active) throw new DriverError("session not created", "Projection already bound.", 409);
      active = true;
      try { await adopt?.(); }
      catch (error) { active = false; throw error; }
      return { sessionId: id, capabilities: { platformName: "Android", "appium:deviceName": "Open Headunit" } };
    }
    const prefix = "/session/" + id;
    if (!active || !(url === prefix || url.startsWith(prefix + "/"))) {
      throw new DriverError("invalid session id", "Unknown projection session.", 404);
    }
    const route = url.slice(prefix.length);
    const element = /^\/element\/([0-9a-f]{32})\/(rect|clear|value)$/.exec(route);
    if (element) {
      const [, fieldId, operation] = element;
      if (method === "GET" && operation === "rect") {
        const field = scene.activeField;
        if (!field || field.id !== fieldId) throw new DriverError("no such element", "Projected field lost focus.", 404);
        const [x, y, r, b] = field.bounds;
        return { x, y, width: r - x, height: b - y };
      }
      if (method === "POST" && operation === "clear") { await rpc({ op: "clear", id: fieldId }, signal); return null; }
      if (method === "POST" && operation === "value" && typeof body.text === "string") {
        return await typeText(body.text, body["agent-device:delayMs"] ?? 0, fieldId, signal);
      }
    }
    switch (method + " " + route) {
      case "DELETE ": active = false; await cancelGesture(); return null;
      case "DELETE /actions": await cancelGesture(); return null;
      case "GET /source":
        return pageSource(await readScene(signal));
      case "GET /window/rect": return scene.viewport;
      case "GET /element/active": {
        const field = scene.activeField;
        if (!field) throw new DriverError("no such element", "No projected text field has focus.", 404);
        return { "element-6066-11e4-a52e-4f735466cecf": field.id };
      }
      case "GET /appium/device/is_keyboard_shown":
        if (typeof scene.keyboardVisible !== "boolean") unsupported("Projection does not report keyboard visibility.");
        return scene.keyboardVisible;
      case "POST /actions": {
        const action = touch ? pointAction(body.actions) : singleGesture(body.actions);
        let expectedTarget;
        let tappedField = false;
        if (action && action.op !== "swipe") {
          const atPoint = (n) => contains(nodeBounds(n), action.x, action.y);
          const hit = scene.nodes?.findLast((n) => n.actions.includes("press") && atPoint(n)) ??
            scene.nodes?.findLast(atPoint);
          if (hit) expectedTarget = { expectedRef: hit.ref,
            ...(action.op === "tap" && hit.pressId && { expectedPressId: hit.pressId }),
            ...(action.op === "tap" && hit.editable && hit.fieldId && { expectedFieldId: hit.fieldId }) };
          tappedField = scene.nodes?.some((n) => n.editable && atPoint(n)) ?? false;
        }
        if (touch) await executeGesture(body.actions, expectedTarget, signal);
        else await rpc({ ...action, ...expectedTarget }, signal);
        if (tappedField) scene = await rpc({ op: "snapshot" }, signal);
        return null;
      }
      case "POST /back": await rpc({ op: "back" }, signal); return null;
      case "POST /keys":
        if (!Array.isArray(body.value) || !body.value.every((v) => typeof v === "string")) invalid("Expected text keys.");
        return await typeText(body.value.join(""), body["agent-device:delayMs"] ?? 0, undefined, signal);
      case "GET /screenshot": return (await rpc({ op: "screenshot" }, signal)).base64;
      case "POST /appium/device/activate_app":
      case "POST /appium/device/terminate_app":
        if (typeof body.appId !== "string" || !body.appId) invalid("Expected a projected app target.");
        await rpc({ op: url.endsWith("/activate_app") ? "open" : "close", target: body.appId }, signal);
        return null;
      case "POST /execute/sync":
        if (body.script === "mobile: deepLink") {
          const { package: target, url: link } = body.args?.[0] ?? {};
          if (typeof target !== "string" || !target || typeof link !== "string" || !link) {
            invalid("Expected a projected app and deep link URL.");
          }
          await rpc({ op: "deepLink", target, url: link }, signal);
          return null;
        }
        if (body.script === "mobile: pressKey" && body.args?.[0]?.keycode === 3) {
          await rpc({ op: "home" }, signal); return null;
        }
        if (body.script === "mobile: pressKey" && body.args?.[0]?.keycode === 187) {
          await rpc({ op: "appSwitcher" }, signal); return null;
        }
        if (body.script === "mobile: pressKey" && [85, 87, 88, 89, 90].includes(body.args?.[0]?.keycode)) {
          await rpc({ op: "mediaKey", keycode: body.args[0].keycode }, signal); return null;
        }
        unsupported("This mobile command has no headunit implementation.");
      default: throw new DriverError("unknown command", "Unknown projection WebDriver route.", 404);
    }
  }

  const server = http.createServer(async (req, res) => {
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.headers.authorization !== "Bearer " + token || req.headers.origin !== undefined) {
        throw new DriverError("invalid argument", "This endpoint belongs to the local headunit session.", 403);
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) invalid("Command body exceeds 1 MiB.");
        chunks.push(chunk);
      }
      let body;
      try { body = size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; }
      catch { invalid("Expected JSON command body."); }
      const value = await route(req.method, req.url, body, controller.signal);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ value }));
    } catch (err) {
      if (res.destroyed) return;
      res.writeHead(err.status ?? 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ value: { error: err.kind ?? "unknown error", message: err.message } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: "http://127.0.0.1:" + server.address().port,
    headers: { Authorization: "Bearer " + token },
    performScroll,
    readScrollScene(signal) {
      requireSession();
      return readScene(signal);
    },
    async readSnapshotSource(signal, includeScreenReader, raw) {
      requireSession();
      const observed = await readScene(signal, includeScreenReader);
      const projected = [];
      const source = pageSource(observed, (node) => projected.push(node), { raw });
      return { source, projected, native: observed.nodes, displays: observed.displays, viewport: observed.viewport,
        keyboardVisible: observed.keyboardVisible };
    },
    updateLayout(layout) { scene = layout; },
    async cleanup() {
      try { await cancelGesture(); }
      finally { await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
    },
  };
}
