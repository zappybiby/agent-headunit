"""Read application windows embedded on Android Auto's trusted activity displays."""

import json
import re
from hashlib import blake2s

from native_nodes import window_nodes
from projection import GEARHEAD_TOOLTIP, TOUCH_IME, car_bounds
from projected_alert import PERMISSION_PACKAGES


RUNNER = "lab.headunit.windowprobe/.ReadProjectedWindow"
GRANT_ACTIVITY = re.compile(r"(?:[\w.]+)?\.permission\.ui\.GrantPermissionsActivity\Z")


def render_panels(panels, records):
    """Resolve runtime permission prompts covering a projected activity."""
    for panel in panels:
        if not panel.get("activity"):
            yield panel
            continue
        for key, (display, owner), _ in records:
            if display != panel["id"]:
                continue
            if owner == panel["owner"]:
                break
            if owner in PERMISSION_PACKAGES:
                package, _, activity = key.partition(" ")[2].partition("/")
                if package == owner and GRANT_ACTIVITY.fullmatch(activity):
                    panel = dict(panel, owner=owner, permissionWindow=key)
                    break
        yield panel


def accessible_windows(adb, serial, panel, mapped_windows):
    owner = panel["owner"]
    if not panel.get("activity") or not re.fullmatch(r"[A-Za-z][\w.]+", owner):
        raise ValueError("Select a projected application activity.")
    output = adb(serial, "shell", "am", "instrument", "-w", "-r", "-e", "display", str(panel["id"]),
                 "-e", "owner", owner, RUNNER)
    payload = re.search(r"(?m)^INSTRUMENTATION_RESULT: trees=(.+)$", output)
    if not payload or not re.search(r"(?m)^INSTRUMENTATION_CODE: -1\s*$", output):
        reason = re.search(r"(?m)^INSTRUMENTATION_RESULT: (?:error|shortMsg)=(.*)$", output)
        raise ValueError(reason[1].strip() if reason else f"Could not run the projected accessibility reader on {serial}.")
    roots = json.loads(payload[1])
    return match_window_roots(roots, panel, mapped_windows)


def match_window_roots(roots, panel, mapped_windows, geometry=None):
    owner = panel["owner"]
    permission_window = panel.get("permissionWindow")
    keys = [key for key, identity in mapped_windows.items() if identity == (panel["id"], owner)]
    if permission_window:
        keys = [key for key in keys if key == permission_window]
    nodes = []
    matched = set()
    for root in roots:
        matching = keys if not permission_window and len(keys) == len(roots) == 1 else [
            key for key in keys if key.partition(" ")[2] == root.get("title")]
        if len(matching) > 1 and geometry:
            exact = [key for key in matching if geometry[key][0] == root.get("frame") and root.get("frame")]
            typed = [key for key in (exact or matching)
                     if geometry[key][1] == root.get("type") and root.get("type")]
            matching = typed or exact or matching
        if len(matching) != 1 or matching[0] in matched:
            raise ValueError("The accessibility window could not be matched to its Android window.")
        matched.add(matching[0])
        window_key = matching[0]
        rows = root["rows"]
        if permission_window:
            # PermissionController can reuse this window for a different question with the same buttons.
            prompt = [(row["id"], row["text"], row["description"], row["enabled"]) for row in rows]
            fingerprint = blake2s(json.dumps(prompt).encode(), digest_size=8).hexdigest()
            window_key += " prompt:" + fingerprint
        captured = accessibility_nodes(rows, panel, window_key, root.get("windowId"))
        if (captured and captured[0].get("reader") and root.get("frame")
                and panel.get("carWindow") not in {TOUCH_IME, GEARHEAD_TOOLTIP}):
            captured[0]["readerWindowBounds"] = car_bounds(panel, root["frame"])
        nodes.extend(captured)
    if not nodes:
        raise ValueError(f"No visible accessibility nodes on projected display {panel['id']}.")
    return nodes


def accessibility_nodes(rows, panel, window_key, window_id=None):
    """Convert absolute Android accessibility bounds to the same projection coordinates as native views."""
    trees = []
    views = []
    for index, row in enumerate(rows):
        parent = row["parent"]
        if not -1 <= parent < index:
            raise ValueError("Invalid accessibility parent.")
        left, top, right, bottom = row["bounds"]
        x, y = rows[parent]["bounds"][:2] if parent >= 0 else (0, 0)
        view = {
            "meta:__name__": row["class"], "meta:__hash__": row.get("uniqueId") or None,
            "layout:left": left - x, "layout:top": top - y, "layout:width": right - left,
            "layout:height": bottom - top, "id": row["id"], "text:text": row["text"],
            "accessibility:contentDescription": row["description"], "text:editable": row["editable"],
            "focus:isFocused": row["focused"], "focus:isFocusable": row["focusable"],
            "misc:enabled": row["enabled"], "misc:selected": row["selected"], "misc:clickable": row["clickable"],
            "misc:longClickable": row["longClickable"], "accessibility:row": row, "children": [],
        }
        if window_id is not None and row.get("guard"):
            view["rendererTarget"] = dict(windowId=window_id, display=panel["id"], windowKey=window_key,
                                          guard=row["guard"])
            if row["editable"]:
                identity = [window_key, window_id, panel["id"], row["uniqueId"], row["class"], row["id"]]
                view["fieldId"] = blake2s(json.dumps(identity).encode(), digest_size=16).hexdigest()
        if "checked" in row:
            view["text:checked"] = row["checked"]
        if row.get("visible") is False:
            view["misc:visibility"] = 4
        views.append(view)
        if parent >= 0:
            views[parent]["children"].append(view)
        else:
            trees.append(view)
    result = []
    for index, tree in enumerate(trees):
        key = f"{window_key} accessibility:{index}"
        for node in window_nodes(tree, panel, key):
            node["carBounds"] = car_bounds(panel, node["bounds"])
            if node.get("pressBounds"):
                node["carPressBounds"] = car_bounds(panel, node["pressBounds"])
            if node.get("scrollBounds"):
                node["carScrollBounds"] = car_bounds(panel, node["scrollBounds"])
            result.append(node)
    return result
