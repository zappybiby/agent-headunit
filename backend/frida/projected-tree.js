"use strict";

const value = (s) => s == null ? "" : s.toString();

function onMain(fn) {
  return new Promise((resolve, reject) => Java.perform(() => {
    Java.scheduleOnMainThread(() => {
      try { resolve(fn()); } catch (error) { reject(error); }
    });
  }));
}

function permissionRows(root, System) {
  const ViewGroup = Java.use("android.view.ViewGroup");
  const TextView = Java.use("android.widget.TextView");
  const rect = Java.use("android.graphics.Rect").$new();
  const resources = root.getResources();
  const rows = [];
  const pending = [root];
  let visited = 0;
  while (pending.length) {
    if (++visited > 4096) throw new Error("The permission window exceeded the node limit.");
    const view = pending.pop();
    if (!view.isShown() || view.getAlpha() <= 0) continue;
    if (ViewGroup.class.isInstance(view)) {
      const group = Java.cast(view, ViewGroup);
      for (let i = group.getChildCount() - 1; i >= 0; i--) pending.push(group.getChildAt(i));
    }
    let id = "";
    if (view.getId() !== -1) {
      try { id = value(resources.getResourceName(view.getId())); } catch (_) { /* The view has a generated ID. */ }
    }
    const isRoot = view === root;
    const button = /:id\/permission_(?:allow|deny)(?:_|$)/u.test(id);
    if (!isRoot && !button && !id.endsWith(":id/permission_message")) continue;
    rect.setEmpty();
    view.getBoundsOnScreen(rect, true);
    if (rect.isEmpty()) {
      if (isRoot) return [];
      continue;
    }
    const text = TextView.class.isInstance(view) ? value(Java.cast(view, TextView).getText()) : "";
    const enabled = view.isEnabled();
    const clickable = button && view.isClickable();
    rows.push({
      parent: isRoot ? -1 : 0, class: value(view.getClass().getName()), id, text,
      uniqueId: String(System.identityHashCode(view)),
      bounds: [rect.left.value, rect.top.value, rect.right.value, rect.bottom.value],
      description: value(view.getContentDescription()), enabled, clickable,
      focused: view.isFocused(), focusable: view.isFocusable(), selected: false,
      editable: false, longClickable: false, scrollable: false, actions: clickable && enabled ? 16 : 0,
      hint: "", showingHint: false, password: false,
    });
  }
  return rows;
}

function windowRoots(displayIds, permissionTitles) {
  const WindowInspector = Java.use("android.view.inspector.WindowInspector");
  const View = Java.use("android.view.View");
  const LayoutParams = Java.use("android.view.WindowManager$LayoutParams");
  const System = Java.use("java.lang.System");
  const views = WindowInspector.getGlobalWindowViews();
  const result = [];
  for (let i = 0; i < views.size(); i++) {
    const root = Java.cast(views.get(i), View);
    const display = root.getDisplay();
    if (!display || !displayIds.includes(display.getDisplayId()) ||
        !root.isAttachedToWindow() || !root.isShown() || root.getWindowVisibility() !== 0) continue;
    const attributes = Java.cast(root.getLayoutParams(), LayoutParams);
    const title = value(attributes.getTitle()) || value(attributes.packageName.value);
    const permissionTitle = permissionTitles[display.getDisplayId()];
    if (permissionTitle && title !== permissionTitle) continue;
    const location = Java.array("int", [0, 0]);
    root.getLocationOnScreen(location);
    const frame = [location[0], location[1], location[0] + root.getWidth(), location[1] + root.getHeight()];
    const types = {1: "BASE_APPLICATION", 2: "APPLICATION", 1003: "APPLICATION_ATTACHED_DIALOG",
      [LayoutParams.TYPE_PRIVATE_PRESENTATION.value]: "PRIVATE_PRESENTATION",
      [LayoutParams.TYPE_PRESENTATION.value]: "PRESENTATION"};
    const window = {display: display.getDisplayId(), windowId: System.identityHashCode(root), title, frame,
      type: types[attributes.type.value],
      modal: root.hasWindowFocus() && (attributes.flags.value & LayoutParams.FLAG_DIM_BEHIND.value) !== 0};
    if (permissionTitle) {
      // The permission controller can expose only its root through the app process accessibility API.
      window.rows = permissionRows(root, System);
    } else {
      const info = root.createAccessibilityNodeInfo();
      info.setQueryFromAppProcessEnabled(root, true);
      window.root = Java.retain(info);
    }
    result.push(window);
  }
  return result;
}

function readWindow(root, rect, target, includeScreenReader = false) {
  const Action = Java.use("android.view.accessibility.AccessibilityNodeInfo$AccessibilityAction");
  const scrollUp = Action.ACTION_SCROLL_UP.value.getId();
  const scrollDown = Action.ACTION_SCROLL_DOWN.value.getId();
  const scrollLeft = Action.ACTION_SCROLL_LEFT.value.getId();
  const scrollRight = Action.ACTION_SCROLL_RIGHT.value.getId();
  const rows = [];
  const handles = [];
  const stack = [{info: root, parent: -1}];
  let visited = 0;
  while (stack.length) {
    const entry = stack.pop();
    const info = entry.info;
    if (++visited > 4096) throw new Error("The projected window exceeded the node limit.");
    let parent = entry.parent;
    info.getBoundsInScreen(rect);
    if (info.isVisibleToUser() && !rect.isEmpty()) {
      const password = info.isPassword();
      const sourceId = info.getSourceNodeId().toString();
      const row = {
        parent, class: value(info.getClassName()), id: value(info.getViewIdResourceName()),
        // Android's node hash includes the accessibility window ID, which can change between reads.
        uniqueId: value(info.getUniqueId()) || sourceId,
        bounds: [rect.left.value, rect.top.value, rect.right.value, rect.bottom.value],
        description: value(info.getContentDescription()), text: password ? "" : value(info.getText()),
        hint: value(info.getHintText()), showingHint: info.isShowingHintText(), password,
        roleDescription: value(info.getExtras().getCharSequence("AccessibilityNodeInfo.roleDescription")),
        heading: info.isHeading(), stateDescription: value(info.getStateDescription()),
        tooltip: value(info.getTooltipText()), selectionStart: info.getTextSelectionStart(),
        selectionEnd: info.getTextSelectionEnd(),
        enabled: info.isEnabled(), focused: info.isFocused(), focusable: info.isFocusable(),
        selected: info.isSelected(), editable: info.isEditable(), clickable: info.isClickable(),
        longClickable: info.isLongClickable(), scrollable: info.isScrollable(), actions: info.getActions(),
      };
      const unnamedClick = (row.actions & 16) !== 0 && !row.text &&
        (!row.description || row.description.trim().toLowerCase() === "image");
      if (row.scrollable || unnamedClick) {
        const actions = info.getActionList();
        let horizontal = false;
        for (let i = 0; i < actions.size(); i++) {
          const action = Java.cast(actions.get(i), Action);
          const id = action.getId();
          if (unnamedClick && id === 16) row.clickLabel = value(action.getLabel());
          if (id === scrollUp) row.hiddenContentAbove = true;
          if (id === scrollDown) row.hiddenContentBelow = true;
          if (id === scrollLeft || id === scrollRight) horizontal = true;
        }
        const vertical = row.hiddenContentAbove || row.hiddenContentBelow;
        if (vertical && !horizontal) row.scrollAxis = "vertical";
        if (horizontal && !vertical) row.scrollAxis = "horizontal";
      }
      if (includeScreenReader) {
        const before = info.getTraversalBefore();
        const after = info.getTraversalAfter();
        row.reader = {
          id: sourceId,
          before: before?.getSourceNodeId().toString(), after: after?.getSourceNodeId().toString(),
          focusable: info.isScreenReaderFocusable(), important: info.isImportantForAccessibility(),
          focusAction: (row.actions & 1) !== 0, stateDescription: row.stateDescription !== "",
          collection: info.getCollectionInfo() !== null, range: info.getRangeInfo() !== null,
        };
      }
      if (info.isCheckable()) row.checked = info.isChecked();
      parent = rows.length;
      rows.push(row);
      if (target) handles.push(info);
    }
    for (let i = info.getChildCount() - 1; i >= 0; i--) {
      const child = info.getChild(i, 0);
      if (child) stack.push({info: child, parent});
    }
  }
  const children = rows.map(() => []);
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    r.guard = Checksum.compute("sha256", JSON.stringify([
      r.uniqueId, r.class, r.id, r.text, r.description, r.tooltip, r.clickLabel,
      r.bounds, r.enabled, r.selected, r.checked, children[i],
    ]));
    if (r.parent >= 0) children[r.parent].push(r.guard);
  }
  if (!target) return rows;
  const found = rows.map((row, i) => row.guard === target.guard ? i : -1).filter(i => i >= 0);
  if (found.length !== 1) return { status: "guard-changed" };
  const index = found[0];
  const row = rows[index];
  if (target.action === "imeEnter") {
    if (!row.enabled || !row.editable || !row.focused) throw new Error("The projected editor lost focus.");
    const enter = Action.ACTION_IME_ENTER.value.getId();
    const node = handles[index];
    const actions = node.getActionList();
    for (let i = 0; i < actions.size(); i++) {
      if (Java.cast(actions.get(i), Action).getId() === enter) return node.performAction(enter);
    }
    throw new Error("The focused projected editor does not expose Return.");
  }
  const codes = {press: 16, longPress: 32, forward: 4096, backward: 8192,
                 setText: 2097152, insertText: 2097152, deleteText: 2097152};
  const action = codes[target.action];
  if (!row.enabled || !action || (row.actions & action) === 0)
    throw new Error("The current node does not support " + target.action + ".");
  if (action !== codes.setText) return handles[index].performAction(action);
  if (!row.editable || (!row.focused && !target.projectedEditor) || typeof target.text !== "string")
    throw new Error("Select the focused projected text field.");
  let text = target.text;
  let cursor = -1;
  if (target.action !== "setText") {
    if (row.password) throw new Error("This field conceals the current text selection.");
    const previous = row.showingHint ? "" : row.text;
    let start = previous ? Math.min(row.selectionStart, row.selectionEnd) : 0;
    const end = previous ? Math.max(row.selectionStart, row.selectionEnd) : 0;
    if (start < 0 || end > previous.length) throw new Error("The field did not expose its edit selection.");
    if (target.action === "deleteText") {
      const count = text.length - (start === end ? 0 : 1);
      const iterator = Java.use("android.icu.text.BreakIterator").getCharacterInstance();
      iterator.setText(Java.use("java.lang.String").$new(previous));
      for (let index = 0; index < count && start > 0; index++) {
        start = Math.max(0, iterator.preceding(start));
      }
      if (start === end) return true;
      text = "";
    }
    cursor = start + text.length;
    text = previous.slice(0, start) + text + previous.slice(end);
  }
  const restoreSelection = cursor >= 0 && cursor !== text.length;
  if (target.action === "deleteText" && restoreSelection && !(row.actions & 131072))
    throw new Error("The projected field cannot restore its edit selection after Backspace.");
  const args = Java.use("android.os.Bundle").$new();
  args.putCharSequence("ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE", Java.use("java.lang.String").$new(text));
  const applied = handles[index].performAction(action, args);
  if (applied && restoreSelection && (row.actions & 131072)) {
    const selection = Java.use("android.os.Bundle").$new();
    selection.putInt("ACTION_ARGUMENT_SELECTION_START_INT", cursor);
    selection.putInt("ACTION_ARGUMENT_SELECTION_END_INT", cursor);
    if (!handles[index].performAction(131072, selection) && target.action === "deleteText") {
      throw new Error("Backspace edited the field but Android did not restore its selection.");
    }
  }
  return applied;
}

rpc.exports = {
  async snapshot(displayIds, target = null, includeScreenReader = false, permissionTitles = {}) {
    if (!Array.isArray(displayIds) || !displayIds.length || displayIds.some(id => !Number.isInteger(id) || id <= 0))
      throw new Error("Select one or more projected displays.");
    const windows = await onMain(() => windowRoots(displayIds, permissionTitles));
    return Java.performNow(() => {
      const rect = Java.use("android.graphics.Rect").$new();
      try {
        const modalDisplays = new Set(windows.filter(w => w.modal).map(w => w.display));
        const visible = windows.filter(w => w.modal || !modalDisplays.has(w.display));
        if (target) {
          const matches = visible.filter(w => w.root && w.display === target.display && w.windowId === target.windowId);
          if (matches.length !== 1) return { status: "guard-changed" };
          return readWindow(matches[0].root, rect, target);
        }
        return visible.map(({root, modal, rows, ...identity}) => ({...identity,
          rows: rows ?? readWindow(root, rect, null, includeScreenReader && identity.type !== undefined)}));
      } finally {
        for (const w of windows) w.root?.$dispose();
      }
    });
  },
};
