import test from "node:test";
import assert from "node:assert/strict";
import { pageSource, singleGesture, startDriver } from "../../../provider/projection/driver.mjs";
import { bindProjectedSnapshot } from "../../../provider/projection/snapshot.mjs";
import { projectedTouchCommand, projectedTouchHelper } from "../../../provider/projection/touch.mjs";

const scene = {
  serial: "phone", viewport: { x: 0, y: 0, width: 800, height: 480 },
  nodes: [
    { ref: "@root", parent: null, className: "Layout", packageName: "car", id: "id/rail",
      actions: [], carBounds: [0, 400, 800, 480], enabled: true },
    { ref: "@button", parent: "@root", className: "CoolwalkButton", id: "id/launcher",
      packageName: "car", description: 'Apps & "tools"', actions: ["press"],
      carBounds: [10, 400, 90, 480], carPressBounds: [15, 405, 85, 475], enabled: true },
  ],
};
const move = (x, y, duration = 0) => ({ type: "pointerMove", x, y, duration });
const contacts = (...steps) => [{ type: "pointer", parameters: { pointerType: "touch" },
  actions: [move(30, 440), { type: "pointerDown", button: 0 }, ...steps, { type: "pointerUp", button: 0 }] }];

test("publishes the renderer's tab and Compose button roles with their own captions", () => {
  const control = { ...scene.nodes[1], className: "android.view.View", description: "", roleDescription: "" };
  const caption = { ...control, ref: "@caption", parent: control.ref, actions: [], text: "Queue",
    className: "android.widget.TextView" };
  const role = { ...caption, ref: "@role", text: "", className: "android.widget.Button" };
  const source = (node, ...rest) => pageSource({ ...scene, nodes: [scene.nodes[0], node, ...rest] });
  assert.match(source(control, caption, role), /class="android.widget.Button".*content-desc="Queue"/);
  assert.match(source({ ...control, roleDescription: "Tab" }, { ...caption, text: "Contacts" }),
    /class="Tab".*content-desc="Contacts"/);
  const secondary = { ...caption, ref: "@other", actions: ["press"], text: "Different action" };
  assert.match(source(control, caption, role, secondary), /text="Different action"/);
});

test("Appium source preserves hierarchy, escaped labels and projected button hit area", () => {
  const xml = pageSource(scene);
  assert.match(xml, /resource-id="id\/rail".*><node class="CoolwalkButton"/);
  assert.match(xml, /content-desc="Apps &amp; &quot;tools&quot;"/);
  assert.match(xml, /bounds="\[15,405\]\[85,475\]"/);
  assert.doesNotMatch(xml, /\sclickable=/);
  assert.match(pageSource({ ...scene, nodes: [
    scene.nodes[0], { ...scene.nodes[1], clickable: true, enabled: false, actions: [] },
  ] }), /clickable="true" enabled="false"/);
  const tab = { ...scene.nodes[1], roleDescription: "tab" };
  const caption = { ...tab, ref: "@caption", parent: tab.ref, id: "id/tab_title", roleDescription: undefined,
    className: "TextView", text: tab.description, description: "", actions: [] };
  const withTab = pageSource({ ...scene, nodes: [scene.nodes[0], tab, caption] });
  assert.match(withTab, /class="Tab" native-class="CoolwalkButton"/);
  assert.match(withTab, /role-description="tab"/);
  assert.doesNotMatch(withTab, /id\/tab_title/);
  assert.match(pageSource({ ...scene, nodes: [scene.nodes[0], tab, { ...caption, actions: ["press"] }] }), /id\/tab_title/);
  const row = { ...tab, roleDescription: "list item" };
  const title = { ...caption, id: "id/row_title" };
  const rowXml = pageSource({ ...scene, nodes: [scene.nodes[0], row, title] });
  assert.match(rowXml, /class="ListItem" native-class="CoolwalkButton"/);
  assert.doesNotMatch(rowXml, /id\/row_title/);
  const subtitle = { ...title, ref: "@subtitle", id: "id/subtitle", text: "Artist" };
  assert.match(pageSource({ ...scene, nodes: [scene.nodes[0], row, title, subtitle] }), /text="Artist"/);
});

test("one projected control publishes its caption once and preserves separate actions with the same name", () => {
  const search = { ...scene.nodes[1], description: "", clickable: true };
  const wrapper = { ...search, ref: "@wrapper", parent: search.ref, description: "Search", id: "",
    clickable: false, actions: [], carBounds: [17, 409, 81, 469], className: "android.widget.FrameLayout" };
  const caption = { ...wrapper, ref: "@caption", parent: wrapper.ref, description: "", text: "Search",
    className: "android.widget.TextView" };
  const secondControl = { ...search, ref: "@second", description: "Search", id: "id/another", carBounds: [210, 400, 290, 480],
    carPressBounds: [215, 405, 285, 475] };
  const projected = { ...scene, nodes: [scene.nodes[0], search, wrapper, caption, secondControl] };
  const refs = [];
  const source = pageSource(projected, ({ ref }) => refs.push(ref));
  assert.deepEqual(refs, ["@root", "@button", "@second"]);
  assert.match(source, /text="Search" content-desc="Search" clickable="true"/);
  assert.equal((source.match(/content-desc="Search"/g) ?? []).length, 2);
  const raw = [];
  pageSource(projected, ({ ref }) => raw.push(ref), { raw: true });
  assert.deepEqual(raw, ["@root", "@button", "@wrapper", "@caption", "@second"]);
  const disabled = { ...search, enabled: false, actions: [], carPressBounds: null };
  const disabledRefs = [];
  const disabledSource = pageSource({ ...projected, nodes: [scene.nodes[0], disabled, wrapper, caption] },
    ({ ref }) => disabledRefs.push(ref));
  assert.deepEqual(disabledRefs, ["@root", "@button"]);
  assert.match(disabledSource, /text="Search" content-desc="Search" clickable="true" enabled="false"/);
});

test("projected snapshots use Android labels and mark passive decoration for text output", async () => {
  const decoration = { ...scene.nodes[0], className: "android.widget.ImageView" };
  const button = { ...scene.nodes[1], className: "android.widget.Button", description: "Image" };
  const named = { ...button, ref: "@named", clickLabel: "Play", tooltip: "Controls" };
  const literal = { ...button, ref: "@literal", text: "Image", tooltip: "Controls" };
  const unnamed = { ...button, id: "", tooltip: "", stateDescription: "Selected" };
  const projected = [decoration, named, literal, unnamed];
  const source = pageSource({ ...scene, nodes: projected });
  assert.match(source, /content-desc="Play"/);
  assert.match(source, /text="Image" content-desc="Image"/);
  assert.match(pageSource({ ...scene, nodes: [decoration, { ...button, tooltip: "Open menu" }] }),
    /content-desc="Open menu"/);
  const capture = bindProjectedSnapshot(async () => ({ source, projected, native: projected, viewport: scene.viewport }), {
    parseWebDriverAndroidSnapshotNodes: () => [{ index: 0 }, { index: 1, label: "Play" },
      { index: 2, label: "Image" }, { index: 3, label: "Image" }],
    acquireProviderKeyboard: ({ nodes }) => ({ nodes }),
  });
  const { nodes } = await capture({}, new AbortController().signal);
  assert.deepEqual(nodes, [
    { index: 0, omitFromTextSnapshot: true },
    { index: 1, label: "Play", contentDescription: "Image" },
    { index: 2, label: "Image" },
    { index: 3, label: "Image", stateDescription: "Selected", presentationLabel: "", presentationHints: ["unlabeled", "tap"] },
  ]);
});

test("W3C pointer coordinates and timing map to a single display gesture", () => {
  assert.deepEqual(singleGesture(contacts()), { op: "tap", x: 30, y: 440 });
  assert.deepEqual(singleGesture(contacts({ type: "pause", duration: 650 })),
    { op: "longPress", x: 30, y: 440, durationMs: 650 });
  assert.deepEqual(singleGesture(contacts(move(30, 390, 100), move(30, 330, 150))),
    { op: "swipe", from: { x: 30, y: 440 }, to: { x: 30, y: 330 }, durationMs: 250 });
  assert.throws(() => singleGesture(contacts(move(30, 440, 100), move(30, 390, 150))), /hold during a moving gesture/);
  assert.throws(() => singleGesture(contacts(move(80, 100, 100), move(30, 430, 100))), /straight swipes/);
  assert.throws(() => singleGesture([...contacts(), ...contacts()]), /one touch/);
});

test("projected touch uses the root transport already verified by the launcher", () => {
  const jar = "/data/local/tmp/headunit-touch-0123456789abcdef.jar";
  const command = `CLASSPATH=${jar} app_process /system/bin headunit.agent.ProjectedTouch`;
  assert.equal(projectedTouchCommand(projectedTouchHelper(jar, "adb-root")), command);
  assert.equal(projectedTouchCommand(projectedTouchHelper(jar, "/debug_ramdisk/su")),
    `/debug_ramdisk/su -c '${command}'`);
  assert.equal(projectedTouchHelper(jar, undefined), undefined);
  assert.equal(projectedTouchHelper(jar, "/system/xbin/su; id"), undefined);
  assert.throws(() => projectedTouchCommand({ jar, root: "/tmp/../su" }), /No projected touch helper/);
});

test("a scrollable list reports the part that receives projected touch", () => {
  const list = {
    ref: "@list", parent: null, className: "androidx.recyclerview.widget.RecyclerView",
    actions: ["scroll-forward"], carBounds: [0, 0, 800, 400], carScrollBounds: [0, 0, 800, 250],
  };
  const source = (node) => pageSource({ ...scene, nodes: [node] });
  assert.match(source(list), /class="androidx.recyclerview.widget.RecyclerView".*scrollable="true".*bounds="\[0,0\]\[800,250\]"/);

  const native = { ...list, className: "android.view.View", scrollAxis: "vertical" };
  assert.match(source(native), /class="android.widget.ScrollView" native-class="android.view.View"/);
  assert.doesNotMatch(source(native), /scroll-axis=/);
  assert.match(source({ ...native, reportedScrollAxis: "vertical" }), /scroll-axis="vertical"/);
  assert.match(source({ ...native, scrollAxis: "horizontal" }), /class="android.widget.HorizontalScrollView"/);
  assert.match(source({ ...native, actions: [] }), /class="android.view.View".*scrollable="false"/);
  assert.match(source({ ...native, carScrollBounds: undefined }), /class="android.view.View"/);
});

test("projected snapshot keeps scroll edges and reader order tied to the published nodes", async () => {
  const controller = new AbortController();
  const list = { ...scene.nodes[0], window: "main", readerWindowBounds: scene.nodes[0].carBounds,
    reader: { id: "1", focusable: true }, hiddenContentBelow: true };
  const item = { ...scene.nodes[1], window: "main", reader: { id: "2", before: "1" }, hiddenContentAbove: true };
  const capture = bindProjectedSnapshot(async (signal, includeScreenReader) => {
    assert.equal(signal, controller.signal);
    assert.equal(includeScreenReader, true);
    return { source: "<hierarchy />", projected: [list, item], native: [list, item],
      viewport: scene.viewport, keyboardVisible: false };
  }, {
    parseWebDriverAndroidSnapshotNodes: () => [{ index: 0 }, { index: 1, label: item.description }],
    acquireProviderKeyboard: ({ nodes }) => ({ nodes, keyboard: { kind: "absent" } }),
    attachReaderFacts: (node, facts) => ({ ...node, facts }),
    buildReaderEvidence: ({ children: [window] }, { sourceNodes: [first, second] }) => {
      assert.equal(first, window);
      assert.equal(second, window.children[0]);
      assert.equal(second.facts.traversalBefore, first.facts.axId);
      return { windows: [{ nodeIndexes: [1, 0], omittedStops: 0 }] };
    },
    attachScreenReaderOrder: (result, read) => ({ ...result, readerOrder: read() }),
  });
  const result = await capture({}, controller.signal);
  assert.deepEqual(result.nodes, [{ index: 0, hiddenContentBelow: true },
    { index: 1, label: item.description, hiddenContentAbove: true }]);
  assert.deepEqual(result.readerOrder.windows[0].nodeIndexes, [1, 0]);
});

test("a scoped projected capture keeps its own hidden edge clues and screen reader source", async () => {
  const signal = new AbortController().signal;
  const main = { ...scene.nodes[0], window: "main", reader: { id: "0" }, readerWindowBounds: [0, 0, 500, 400] };
  const left = { ...scene.nodes[1], ref: "@left", parent: main.ref, window: "main", reader: { id: "1" },
    hiddenContentAbove: true };
  const right = { ...left, ref: "@right", reader: { id: "2" }, hiddenContentAbove: undefined, hiddenContentBelow: true };
  const capture = bindProjectedSnapshot(async () => ({ source: "<hierarchy />", projected: [main, left, right],
    native: [main, left, right], viewport: scene.viewport }), {
    parseWebDriverAndroidSnapshotNodes: () => [{ index: 0 }, { index: 1, label: left.description },
      { index: 2, label: right.description }],
    acquireProviderKeyboard: ({ nodes }) => ({ nodes }),
    scopeSnapshotNodes: (nodes, scope) => {
      assert.equal(scope, "right list");
      assert.equal(nodes[1].hiddenContentAbove, true);
      return [{ ...nodes[2], index: 0 }];
    },
    attachReaderFacts: (node, facts) => ({ ...node, facts }),
    attachScreenReaderOrder: (data, build) => ({ ...data, screenReaderOrder: build() }),
    buildReaderEvidence: (_root, { sourceNodes: [node] }) => node.facts.axId,
  });
  assert.deepEqual(await capture({ options: { scope: "right list" } }, signal), {
    nodes: [{ index: 0, label: right.description, hiddenContentBelow: true }], viewport: { width: 800, height: 480 },
    backend: "android", producer: "appium-source", screenReaderOrder: 2,
  });
});

test("projected density follows the Android display that owns each captured node", async () => {
  const signal = new AbortController().signal;
  const left = { id: 1, width: 400, height: 400, carBounds: [0, 0, 400, 400], densityDpi: 320 };
  const right = { id: 2, width: 200, height: 200, carBounds: [400, 0, 800, 400], densityDpi: 160 };
  const native = [{ display: 1 }, { display: 2 }];
  let displays = [left, right, { id: 3 }];
  const capture = bindProjectedSnapshot(async () => ({ source: "<hierarchy />", projected: native,
    native, displays, viewport: scene.viewport }), {
    parseWebDriverAndroidSnapshotNodes: () => [{ index: 0 }, { index: 1 }],
    acquireProviderKeyboard: ({ nodes }) => ({ nodes }),
    scopeSnapshotNodes: (nodes, scope) => {
      assert.equal(scope, "left");
      return [nodes[0]];
    },
  });
  assert.equal((await capture({}, signal)).rectUnitsPerDp, 2);
  const density = Symbol.for("agent-device.snapshot.node.rectUnitsPerDp");
  for (const [panel, expected] of [[{ ...right, densityDpi: 200 }, 2.5],
    [{ ...right, densityDpi: undefined }, undefined],
    [{ ...right, carBounds: [400, 0, 800, 399] }, undefined]]) {
    displays = [left, panel];
    const snapshot = await capture({}, signal);
    assert.equal(snapshot.rectUnitsPerDp, undefined);
    assert.deepEqual(snapshot.nodes.map((node) => node[density]), [2, expected]);
  }
  assert.equal((await capture({ options: { scope: "left", interactiveOnly: true } }, signal)).rectUnitsPerDp, 2);
});

test("private WebDriver session reads its projection and pins input to the observed native node", async () => {
  const calls = [];
  const pressId = "a".repeat(32);
  const projection = { ...scene, nodes: [scene.nodes[0], { ...scene.nodes[1], pressId }] };
  let adoptions = 0;
  const driver = await startDriver({ serial: scene.serial, viewport: scene.viewport }, async (request) => {
    calls.push(request);
    return request.op === "snapshot" ? { ok: true, ...projection } : { ok: true };
  }, undefined, async () => { adoptions++; });
  const request = async (method, path, body, headers = driver.headers) => {
    const response = await fetch(driver.endpoint + path, {
      method, headers, ...(body && { body: JSON.stringify(body) }),
    });
    return [response.status, (await response.json()).value];
  };
  try {
    assert.equal((await request("POST", "/session", {}, {}))[0], 403);
    assert.equal(adoptions, 0);
    const [code, created] = await request("POST", "/session", {});
    assert.equal(code, 200);
    assert.equal(adoptions, 1);
    assert.equal((await request("POST", "/session", {}))[0], 409);
    assert.equal(adoptions, 1);
    const session = "/session/" + created.sessionId;
    assert.equal((await request("POST", session + "/actions", { actions: contacts() }))[0], 200);
    assert.match((await request("GET", session + "/source"))[1], /CoolwalkButton/);
    assert.equal((await request("POST", session + "/actions", { actions: contacts() }))[0], 200);
    assert.deepEqual(calls, [{ op: "tap", x: 30, y: 440, serial: "phone" }, { op: "snapshot", serial: "phone" },
      { op: "tap", x: 30, y: 440, serial: "phone", expectedRef: "@button", expectedPressId: pressId }]);
    for (const keycode of [85, 87, 88]) {
      assert.equal((await request("POST", session + "/execute/sync",
        { script: "mobile: pressKey", args: [{ keycode }] }))[0], 200);
      assert.deepEqual(calls.at(-1), { op: "mediaKey", keycode, serial: "phone" });
    }
    assert.equal((await request("POST", session + "/execute/sync",
      { script: "mobile: deepLink", args: [{ url: "fixture://open", package: "example.projected" }] }))[0], 200);
    assert.deepEqual(calls.at(-1), {
      op: "deepLink", serial: "phone", target: "example.projected", url: "fixture://open",
    });
    assert.equal((await request("POST", session + "/appium/device/terminate_app",
      { appId: "example.projected" }))[0], 200);
    assert.deepEqual(calls.at(-1), { op: "close", serial: "phone", target: "example.projected" });
    assert.equal((await request("DELETE", session))[0], 200);
    assert.equal((await request("GET", session + "/source"))[0], 404);
  } finally { await driver.cleanup(); }
});

test("a tap pins the editor identity along with the ref captured before its focus can change", async () => {
  const fieldId = "a".repeat(32);
  const editor = { ...scene.nodes[1], editable: true, fieldId };
  const projection = { ...scene, nodes: [scene.nodes[0], editor] };
  const calls = [];
  const driver = await startDriver(projection, async (request) => {
    calls.push(request);
    return { ok: true, ...projection };
  });
  const post = (path, body) => fetch(driver.endpoint + path, {
    method: "POST", headers: driver.headers, body: JSON.stringify(body),
  });
  try {
    const { value } = await (await post("/session", {})).json();
    const response = await post("/session/" + value.sessionId + "/actions", { actions: contacts() });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ op: "tap", x: 30, y: 440, serial: "phone", expectedRef: editor.ref,
      expectedFieldId: fieldId }, { op: "snapshot", serial: "phone" }]);
  } finally { await driver.cleanup(); }
});

test("paced text keeps Unicode characters intact and stops when its field loses focus", async () => {
  const fieldId = "a".repeat(32);
  const calls = [];
  let focused = true;
  const driver = await startDriver(scene, async (request) => {
    if (request.op === "field") return { field: { id: fieldId } };
    calls.push({ ...request, time: performance.now() });
    if (!focused) throw new Error("The projected text field no longer has focus.");
    if (request.text === "B") focused = false;
    return { ok: true };
  });
  const post = (path, body) => fetch(driver.endpoint + path, {
    method: "POST", headers: driver.headers, body: JSON.stringify(body),
  });
  try {
    const created = await (await post("/session", {})).json();
    const session = "/session/" + created.value.sessionId;
    const delay = { "agent-device:delayMs": 22 };
    const typed = await post(session + "/keys", { value: ["A", "😀"], ...delay });
    assert.equal(typed.status, 200);
    assert.deepEqual(calls.map(({ id, text }) => [id, text]), [[fieldId, "A"], [fieldId, "😀"]]);
    assert.ok(calls[1].time - calls[0].time >= 18);
    const filled = await post(session + "/element/" + fieldId + "/value", { text: "BCD", ...delay });
    assert.match((await filled.json()).value.message, /no longer has focus/);
    assert.deepEqual(calls.slice(2).map(({ id, text }) => [id, text]), [[fieldId, "B"], [fieldId, "C"]]);
  } finally { await driver.cleanup(); }
});
