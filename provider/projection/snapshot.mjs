const nodeRectUnitsPerDp = Symbol.for("agent-device.snapshot.node.rectUnitsPerDp");
const passiveClasses = new Set([
  "android.view.View", "android.view.ViewGroup", "android.widget.FrameLayout", "android.widget.LinearLayout",
  "android.widget.RelativeLayout", "android.widget.ImageView", "androidx.cardview.widget.CardView",
]);

function annotatePresentation(node, control) {
  const genericImage = node.label?.trim().toLowerCase() === "image" && !control.text?.trim();
  const unnamed = !node.label?.trim() || genericImage;
  const pressable = control.actions?.includes("press");
  const interactive = control.actions?.length || control.clickable || control.longClickable ||
    control.editable || control.checkable || control.scrollAxis || control.focusable || control.focused;
  if (control.description && control.description !== node.label && !node.contentDescription) {
    node.contentDescription = control.description;
  }
  const state = control.stateDescription?.trim().replace(/\s+/g, " ");
  if (state) node.stateDescription = state;
  if (unnamed && !interactive && passiveClasses.has(control.className) &&
      !node.value && !control.hint && !control.roleDescription && !control.heading && !state &&
      !control.reader?.collection && !control.reader?.range && !control.hiddenContentAbove && !control.hiddenContentBelow) {
    node.omitFromTextSnapshot = true;
  } else if (unnamed && interactive) {
    node.presentationLabel = node.identifier?.split(":id/").at(-1) ?? "";
    node.presentationHints = [...(node.presentationHints ?? []), "unlabeled", ...(pressable ? ["tap"] : [])];
  } else if (unnamed && state) {
    node.presentationLabel = "";
  }
}

function bounds([x, y, right, bottom]) {
  return { x, y, width: right - x, height: bottom - y };
}

function projectedDensity(displays, nodes) {
  const scaleByDisplay = new Map();
  for (const panel of displays) {
    if (!panel.carBounds) continue;
    const car = bounds(panel.carBounds);
    const extents = [car.width, car.height, panel.width, panel.height, panel.densityDpi];
    if (!extents.every((value) => Number.isSafeInteger(value) && value > 0)) continue;
    const [carWidth, carHeight, nativeWidth, nativeHeight, dpi] = extents.map(BigInt);
    if (carWidth * nativeHeight !== carHeight * nativeWidth) continue;
    const numerator = carWidth * dpi;
    scaleByDisplay.set(panel.id, {
      numerator, denominator: nativeWidth, unitsPerDp: Number(numerator) / Number(nativeWidth) / 160,
    });
  }
  const scales = nodes.map((node) => scaleByDisplay.get(node.display));
  const first = scales[0];
  if (first && scales.every((scale) => scale &&
    scale.numerator * first.denominator === first.numerator * scale.denominator)) {
    return { rectUnitsPerDp: first.unitsPerDp };
  }
  return { perNode: scales.map((scale) => scale?.unitsPerDp) };
}

function readerEvidence(native, projected, nodes, { attachReaderFacts, buildReaderEvidence }) {
  const entries = native.filter((node) => node.reader);
  const identities = new Map();
  for (const [index, node] of entries.entries()) {
    const key = node.window + "/" + node.reader.id;
    identities.set(key, identities.has(key) ? undefined : index);
  }
  const byRef = new Map();
  const root = { children: [] };
  for (const [index, node] of entries.entries()) {
    const { id: _id, before, after, focusable, ...facts } = node.reader;
    const parent = byRef.get(node.parent);
    if (node.parent !== null && !parent) continue;
    const reader = attachReaderFacts({
      children: [], rect: bounds(node.carBounds), type: node.className, label: node.text || node.description,
      visibleToUser: node.visible, scrollable: Boolean(node.scrollAxis),
      clickable: node.readerClickable, focusable: node.focusable,
      passiveFacts: { checked: node.checked, longClickable: node.longClickable, placeholder: node.hint },
      ...(node.readerWindowBounds && { windowType: 1, windowRect: bounds(node.readerWindowBounds) }),
    }, {
      ...facts, axId: index, screenReaderFocusable: focusable,
      traversalBefore: identities.get(node.window + "/" + before),
      traversalAfter: identities.get(node.window + "/" + after),
    });
    (parent ?? root).children.push(reader);
    byRef.set(node.ref, reader);
  }
  return buildReaderEvidence(root, { nodes, sourceNodes: projected.map((node) => byRef.get(node.ref)) });
}

export function bindProjectedSnapshot(readSource, upstream) {
  const { parseWebDriverAndroidSnapshotNodes: parseSource, acquireProviderKeyboard: acquireKeyboard,
    attachScreenReaderOrder, scopeSnapshotNodes } = upstream;
  return async (input, bindingSignal) => {
    const signal = input.signal ? AbortSignal.any([bindingSignal, input.signal]) : bindingSignal;
    const includeScreenReader = input.options?.interactiveOnly !== true;
    const { source, projected, native, displays = [], viewport, keyboardVisible } =
      await readSource(signal, includeScreenReader, input.options?.raw === true);
    signal.throwIfAborted();
    let nodes = parseSource(source);
    if (nodes.length !== projected.length || nodes.some((node, index) => node.index !== index)) {
      throw new Error("The projected accessibility nodes could not be matched to the snapshot.");
    }
    for (const node of nodes) annotatePresentation(node, projected[node.index]);
    if (input.options?.includeHiddenContentHints !== false) {
      for (const node of nodes) {
        const control = projected[node.index];
        if (control.hiddenContentAbove === true) node.hiddenContentAbove = true;
        if (control.hiddenContentBelow === true) node.hiddenContentBelow = true;
      }
    }
    let sourceNodes = projected;
    if (input.options?.scope?.trim()) {
      const scoped = scopeSnapshotNodes(nodes.map((node) => ({ ...node, sourceIndex: node.index })), input.options.scope);
      sourceNodes = scoped.map(({ sourceIndex }) => projected[sourceIndex]);
      nodes = scoped.map(({ sourceIndex: _sourceIndex, ...node }) => node);
    }
    const { rectUnitsPerDp, perNode } = projectedDensity(displays, sourceNodes);
    if (perNode) {
      for (const [index, unitsPerDp] of perNode.entries()) {
        if (unitsPerDp !== undefined) nodes[index][nodeRectUnitsPerDp] = unitsPerDp;
      }
    }
    const capture = {
      ...acquireKeyboard({ nodes, viewport: null, visibility: keyboardVisible ?? "unsupported" }),
      viewport: { width: viewport.width, height: viewport.height },
      ...(rectUnitsPerDp !== undefined && { rectUnitsPerDp }),
      backend: "android",
      producer: "appium-source",
    };
    if (includeScreenReader && native.some((node) => node.readerWindowBounds)) {
      return attachScreenReaderOrder(capture, () => readerEvidence(native, sourceNodes, capture.nodes, upstream));
    }
    return capture;
  };
}
