"""Translate a car touch plan into one Android display."""

import math

from projection.displays import hit_panel
from projection.connection import HeadunitError, adb


def display_gesture(panels, frames):
    if not isinstance(frames, list) or not 1 <= len(frames) <= 4096:
        raise HeadunitError("Expected a bounded touch plan.")

    target = None
    pointer_ids, contacts = {}, set()
    result = []
    last = -1
    count = 0
    for frame in frames:
        at, events = frame["atMs"], frame["events"]
        if type(at) is not int or not max(0, last) <= at <= 60000 or not isinstance(events, list) or not events:
            raise HeadunitError("The touch plan contains an invalid frame.")
        last = at
        count += len(events)
        if count > 16384:
            raise HeadunitError("The touch plan has too many pointer events.")
        translated = []
        for event in events:
            pointer, phase = event["id"], event["phase"]
            x, y = event["x"], event["y"]
            if not isinstance(pointer, str) or not 1 <= len(pointer) <= 128 or phase not in {"down", "move", "up"}:
                raise HeadunitError("The touch plan contains an invalid pointer event.")
            if not all(type(value) in (int, float) and math.isfinite(value) for value in (x, y)):
                raise HeadunitError("The touch plan needs finite car coordinates.")
            if phase == "down":
                if pointer in contacts:
                    raise HeadunitError("A pointer is already down.")
                panel, _, _ = hit_panel(panels, x, y)
                if target is None:
                    target = panel
                elif panel["id"] != target["id"]:
                    raise HeadunitError("A new pointer landed on another projected Android display.")
                pointer_ids.setdefault(pointer, len(pointer_ids))
                if len(pointer_ids) > 5:
                    raise HeadunitError("The touch plan has too many pointers.")
                contacts.add(pointer)
            elif pointer not in contacts:
                raise HeadunitError("A pointer moved or lifted without a down action.")
            elif phase == "up":
                contacts.remove(pointer)

            # Android keeps an active touch on its original display when it moves beneath a car overlay.
            left, top, right, bottom = target["carBounds"]
            screen = target["screen"]
            if not (max(0, left) <= x < min(right, screen["width"]) and
                    max(0, top) <= y < min(bottom, screen["height"])):
                raise HeadunitError("A pointer moved outside its original projected panel bounds.")
            translated.append({"id": pointer_ids[pointer], "phase": phase,
                               "x": (x - left) * target["width"] / (right - left),
                               "y": (y - top) * target["height"] / (bottom - top)})
        result.append({"atMs": at, "events": translated})

    if contacts:
        raise HeadunitError("The touch plan left an active pointer.")
    return {"displayId": target["id"], "width": target["width"], "height": target["height"], "frames": result}


def point(panels, data):
    x, y = data.get("x"), data.get("y")
    if not all(type(value) in (int, float) and math.isfinite(value) for value in (x, y)):
        raise HeadunitError("Expected a finite car display coordinate.")
    panel, local_x, local_y = hit_panel(panels, x, y)
    return panel, local_x, local_y


def guard_touch_ref(tree, ref, panel, x, y, field_id=None, press_id=None):
    if ref:
        def occupies(regions):
            return any(l <= x < r and t <= y < b for l, t, r, b in regions)

        if press_id:
            controls = [n for n in tree["nodes"] if n.get("pressId") == press_id]
            item = controls[0] if len(controls) == 1 else None
        else:
            item = next((n for n in tree["nodes"] if n["ref"] == ref), None)
        if not item and field_id and not press_id:
            editors = [n for n in tree["nodes"] if n.get("fieldId") == field_id and n["enabled"] and n["editable"]]
            if len(editors) == 1:
                item = editors[0]
        if not item:
            raise HeadunitError("The control moved or disappeared. Capture a new snapshot.")
        if item["display"] != panel["id"]:
            raise HeadunitError("Another projected window covers that control.")
        regions = item.get("pressRegions") if "press" in item["actions"] else [item["bounds"]]
        if not occupies(regions):
            raise HeadunitError("The control no longer occupies that point.")
        if press_id:
            topmost = next((n for n in reversed(tree["nodes"]) if n["display"] == panel["id"]
                            and "press" in n["actions"] and occupies(n["pressRegions"])), None)
            if topmost is not item:
                raise HeadunitError("Another projected control occupies that point. Capture a new snapshot.")


def gesture(tree, data):
    op = data["op"]
    panel, x, y = point(tree["displays"], data["from"] if op == "swipe" else data)
    guard_touch_ref(tree, data.get("expectedRef"), panel, x, y, data.get("expectedFieldId"), data.get("expectedPressId"))
    args = ["tap", x, y]
    if op != "tap":
        duration = data.get("durationMs", 600)
        if type(duration) is not int or not 1 <= duration <= 60000:
            raise HeadunitError("Gesture duration must be between 1 and 60000 milliseconds.")
        target, end_x, end_y = point(tree["displays"], data["to"]) if op == "swipe" else (panel, x, y)
        if target["id"] != panel["id"]:
            raise HeadunitError("The gesture crosses two Android Auto panels.")
        args = ["swipe", x, y, end_x, end_y, duration]
    adb(tree["serial"], "shell", "input", "-d", str(panel["id"]), *map(str, args))
    return {"ok": True}
