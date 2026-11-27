"""Read and operate the keyboard on the projected display."""

import time

from controls.gestures import gesture
from projection.displays import GEARHEAD, GEARHEAD_TOOLTIP, TOUCH_IME, hit_panel
from projection.connection import HeadunitError, adb, projected_field, window_records


KEYBOARD_CLOSE = GEARHEAD + ":id/key_close"
KEYBOARD_SEARCH = GEARHEAD + ":id/key_search"


def keyboard_key(tree, resource):
    displays = {p["id"] for p in tree["displays"] if p.get("carWindow") == TOUCH_IME and p["owner"] == GEARHEAD}
    keys = [node for node in tree["nodes"] if node["display"] in displays
            and node["packageName"] == GEARHEAD and node["id"] == resource]
    return keys[0] if len(keys) == 1 else None


def keyboard_tooltip_covers(tree, key, x, y):
    keyboard_panel = next(panel for panel in tree["displays"] if panel["id"] == key["display"])
    left, top, right, bottom = key["carBounds"]
    covering = []
    for panel in tree["displays"]:
        if panel["z"] > keyboard_panel["z"]:
            cover_left, cover_top, cover_right, cover_bottom = panel["carBounds"]
            if max(left, cover_left) < min(right, cover_right) and max(top, cover_top) < min(bottom, cover_bottom):
                covering.append(panel)
    if len(covering) != 1:
        return False
    tooltip = covering[0]
    cover_left, cover_top, cover_right, cover_bottom = tooltip["carBounds"]
    if (tooltip["owner"] != GEARHEAD or tooltip.get("carWindow") != GEARHEAD_TOOLTIP
            or not (cover_left <= left < right <= cover_right and cover_top <= top < bottom <= cover_bottom)):
        return False
    try:
        panel, _, _ = hit_panel(tree["displays"], x, y)
    except ValueError:
        return False
    return panel["id"] == tooltip["id"]


def perform_keyboard_action(tree, node, action):
    from accessibility.renderer import read_windows
    records = list(window_records(adb(tree["serial"], "shell", "dumpsys", "window", "windows")))
    read_windows(tree["serial"], tree["displays"], records, dict(node["rendererTarget"], action=action))


def tap_keyboard_key(tree, key, name):
    if not key or not key["enabled"]:
        raise HeadunitError(f"The projected keyboard has no available {name} key.")
    left, top, right, bottom = key.get("carPressBounds") or key["carBounds"]
    x, y = (left + right) // 2, (top + bottom) // 2
    if (key["id"] == KEYBOARD_CLOSE and key.get("pressRegions") == [] and key.get("rendererTarget")
            and keyboard_tooltip_covers(tree, key, x, y)):
        perform_keyboard_action(tree, key, "press")
        return
    gesture(tree, {"op": "tap", "x": x, "y": y, "expectedRef": key["ref"]})


def keyboard(connection, op):
    tree = connection.snapshot(include_nodes=op == "keyboardEnter")
    if op != "keyboardEnter" and tree["keyboardVisible"]:
        tree = connection.snapshot()
    visible = tree["keyboardVisible"]
    if op == "keyboardStatus":
        status = {"ok": True, "kind": "ime-probe", "visible": visible}
        if visible:
            field = projected_field(tree)
            key = keyboard_key(tree, KEYBOARD_SEARCH)
            status.update(inputMethodPackage=GEARHEAD, inputOwner="app" if field else "unknown",
                          returnKey="search" if key else "unknown")
            if field:
                status["focusedPackage"] = field["packageName"]
                if field.get("id"):
                    status["focusedResourceId"] = field["id"]
            if key:
                label = (key.get("description") or key.get("text") or "").strip()
                if label:
                    status["returnKeyLabel"] = label
        return status
    if op == "keyboardDismiss":
        if visible:
            tap_keyboard_key(tree, keyboard_key(tree, KEYBOARD_CLOSE), "close")
            deadline = time.monotonic() + 2
            while connection.snapshot(include_nodes=False)["keyboardVisible"]:
                if time.monotonic() >= deadline:
                    raise HeadunitError("The projected keyboard remained visible after pressing its close key.")
                time.sleep(0.1)
        return {"ok": True, "kind": "ime-probe", "visible": False, "wasVisible": visible,
                "dismissed": visible, "attempts": int(visible)}
    field = projected_field(tree)
    if not field:
        raise HeadunitError("Focus the projected text field that should receive Return.")
    if visible:
        tap_keyboard_key(tree, keyboard_key(tree, KEYBOARD_SEARCH), "Return")
    else:
        perform_keyboard_action(tree, field, "imeEnter")
    return {"ok": True, "kind": "android-acknowledged"}
