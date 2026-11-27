"""Translate a car touch plan into one Android display."""

import math

from projection import hit_panel
from transport import HeadunitError


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
