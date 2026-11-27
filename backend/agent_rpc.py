"""Projection operations used by the agent-device provider."""

import base64
from io import BytesIO
import json
import math
import os
import re
import sys
import time

from projection import COMPONENT, GEARHEAD, GEARHEAD_TOOLTIP, LAUNCHER_WINDOW, TOUCH_IME, hit_panel
from transport import (HeadunitError, NoVisibleProjection, StaleProjectedControl, adb, check_streaming_block,
                       projected_field, window_records)


RECEIVER = "com.andrerinas.headunitrevived"
PROJECTION_TARGETS = {GEARHEAD, RECEIVER, "Android Auto", "Open Headunit"}
KEYBOARD_CLOSE = GEARHEAD + ":id/key_close"
KEYBOARD_SEARCH = GEARHEAD + ":id/key_search"
PACKAGE_NAME = re.compile(r"[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+", re.ASCII)


def receiver_serial(phone, requested=None):
    requested = requested or os.environ.get("HEADUNIT_RECEIVER_SERIAL")
    devices = [requested] if requested else connected_devices_except(phone)
    candidates = []
    for serial in devices:
        state = adb(serial, "shell", "dumpsys", "activity", "activities")
        if re.search(r"topResumedActivity=[^\n]*" + re.escape(RECEIVER) +
                     r"/[^\n]*\.AapProjectionActivity\b", state):
            candidates.append(serial)
    if len(candidates) != 1:
        if requested:
            raise HeadunitError(f"Open an active projection in Open Headunit on {requested}.")
        raise HeadunitError("Select an active Open Headunit receiver with HEADUNIT_RECEIVER_SERIAL.")
    return candidates[0]


def connected_devices_except(serial):
    return [line.split()[0] for line in adb(None, "devices").splitlines()
            if re.fullmatch(r"\S+\s+device", line.strip()) and line.split()[0] != serial]


def car_key(phone, keycode):
    receiver = receiver_serial(phone)
    adb(receiver, "shell", "am", "broadcast", "-a", "com.android.music.musicservicecommand",
        "-n", RECEIVER + "/com.andrerinas.openheadunit.app.RemoteControlReceiver", "--ei", "keycode", str(keycode))
    return {"ok": True}


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
    from renderer import read_windows
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


def screenshot(tree):
    from PIL import Image
    receiver = receiver_serial(tree["serial"])
    raw = adb(receiver, "exec-out", "screencap", "-p", binary=True)
    width, height = tree["viewport"]["width"], tree["viewport"]["height"]
    with Image.open(BytesIO(raw)) as image:
        if image.width * height != image.height * width:
            raise HeadunitError("Receiver image and car display have different aspect ratios.")
        output = BytesIO()
        image.resize((width, height), Image.Resampling.LANCZOS).save(output, format="PNG")
    return {"ok": True, "base64": base64.b64encode(output.getvalue()).decode("ascii")}


def projected_app_state(tree):
    focus = [panel for panel in tree["displays"] if panel.get("appFocused")]
    if len(focus) != 1:
        raise HeadunitError("Android Auto did not identify one focused projected app window.")
    panel = focus[0]
    package = panel["owner"]
    windows = adb(tree["serial"], "shell", "dumpsys", "window", "windows")
    if not any(identity == (panel["id"], package) for _, identity, _ in window_records(windows)):
        raise HeadunitError("The focused projected app window changed while it was being read.")
    result = {"ok": True, "package": package}
    if panel.get("activity"):
        from projected_lifecycle import resumed_activities
        resumed = {activity.partition("/")[2] for activity, _ in resumed_activities(tree["serial"], panel["id"])
                   if activity and activity.partition("/")[0] == package}
        if len(resumed) == 1:
            result["activity"] = resumed.pop()
    return result


def launcher_display(tree):
    displays = [panel["id"] for panel in tree["displays"] if panel["carWindow"] == LAUNCHER_WINDOW
                and panel["owner"] == GEARHEAD and panel["hitRegions"]]
    if len(displays) > 1:
        raise HeadunitError("Android Auto reported multiple available launcher windows.")
    return displays[0] if displays else None


def show_launcher(unit, tree):
    if launcher_display(tree) is not None:
        return tree
    car_key(tree["serial"], 3)
    deadline = time.monotonic() + 8
    while True:
        latest = unit.connection.snapshot(include_nodes=False)
        if launcher_display(latest) is not None:
            return latest
        if time.monotonic() >= deadline:
            raise HeadunitError("Android Auto did not open the launcher.")
        time.sleep(0.1)


def open_projected_app(unit, tree, target):
    from launcher import component_labels, launcher_apps

    component = COMPONENT.fullmatch(target)
    package = component[1] if component else target if PACKAGE_NAME.fullmatch(target) else None
    if component and component[2].startswith("."):
        target = package + "/" + package + component[2]
    elif component and "." not in component[2]:
        target = f"{package}/{package}.{component[2]}"
    serial = tree["serial"]
    selected = None
    if package:
        apps = launcher_apps(serial)["apps"]
        candidates = [app for app in apps if app["package"] == package and (not component or app["component"] == target)]
        if len(candidates) != 1 or candidates[0]["profile"] != "PERSONAL":
            raise HeadunitError(f"Android Auto did not report one personal launcher component for {target!r}.")
        selected = candidates[0]["component"]
        focused = [panel for panel in tree["displays"] if panel["owner"] == package and panel.get("appFocused") and (
                panel.get("activity") == selected or panel.get("components") == [selected])
        ]
        if focused:
            if not candidates[0].get("native"):
                return {"ok": True, "package": package, "component": selected}
            records = list(window_records(adb(serial, "shell", "dumpsys", "window", "windows")))
            check_streaming_block(focused, records)
            owned_displays = {display for _, (display, owner), pid in records if owner == package and pid}
            if any(panel["id"] in owned_displays for panel in focused):
                return {"ok": True, "package": package, "component": selected}
    launcher = show_launcher(unit, tree)
    display = launcher_display(launcher)
    for attempt in range(2):
        title = target
        if selected:
            windows = adb(serial, "shell", "dumpsys", "window", "windows")
            pids = {pid for _, identity, pid in window_records(windows) if identity == (display, GEARHEAD)}
            if len(pids) != 1 or None in pids:
                raise HeadunitError("Android did not report the launcher window's process.")
            labels = component_labels(serial, pids.pop(), apps)
            declared = [label["label"] for label in labels if label["component"] == selected]
            if len(declared) != 1 or sum(label["label"] == declared[0] for label in labels) != 1:
                raise HeadunitError(f"Android Auto did not report a unique launcher title for {target!r}.")
            title = declared[0]
        tree = unit.snapshot()
        if tree["serial"] != serial or launcher_display(tree) != display:
            raise HeadunitError("The Android Auto launcher changed before app selection.")
        nodes = {node["ref"]: node for node in tree["nodes"] if node["display"] == display}
        tiles = [node for node in nodes.values() if node.get("text") == title and (
            (node.get("id") or "").rsplit("/", 1)[-1] == "grid_item_title"
            or (node["className"] == "android.widget.TextView"
                and "press" in nodes.get(node.get("parent"), {}).get("actions", ()))
        )]
        if len(tiles) != 1:
            raise HeadunitError(f"Android Auto did not show one visible launcher tile named {title!r}.")
        try:
            return unit.press("ref=" + tiles[0]["ref"], observed=tree)
        except StaleProjectedControl:
            if attempt:
                raise


def port_reverse(data):
    serial, transport_id = data.get("serial"), data.get("transportId")
    device_port, host_port, token = data.get("devicePort"), data.get("hostPort"), data.get("token")
    remove = data.get("remove") is True
    if not isinstance(serial, str) or not re.fullmatch(r"[a-zA-Z0-9._:/-]{1,128}", serial):
        raise HeadunitError("Specify the projecting phone's ADB serial.")
    if not isinstance(transport_id, str) or not re.fullmatch(r"[1-9]\d*", transport_id):
        raise HeadunitError("Specify the projecting phone's ADB transport ID.")
    if not all(type(port) is int and 1 <= port <= 65535 for port in (device_port, host_port)):
        raise HeadunitError("Port reverse requires TCP ports from 1 to 65535.")
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{32}", token):
        raise HeadunitError("Specify the owner of the projecting phone's reverse mapping.")

    inventory = adb(None, "devices", "-l").splitlines()
    if not inventory or inventory[0].strip() != "List of devices attached":
        raise HeadunitError("Could not verify the projecting phone's ADB transport.")
    rows = [line.split() for line in inventory[1:] if line.split()[:1] == [serial]]
    if len(rows) > 1 or rows and not any(value.startswith("transport_id:") for value in rows[0][2:]):
        raise HeadunitError("ADB returned an ambiguous transport for the projecting phone.")
    if not rows or "transport_id:" + transport_id not in rows[0][2:]:
        if remove:
            return {"ok": True}
        raise HeadunitError("The projecting phone's ADB transport changed before Metro forwarding.")
    if rows[0][1] != "device":
        raise HeadunitError("The projecting phone's ADB transport is not ready.")

    def reverse(*args):
        return adb(serial, "reverse", *args, transport_id=transport_id)

    device, host = f"tcp:{device_port}", f"tcp:{host_port}"
    marker = "localabstract:agent-device-headunit-" + token
    pending = marker + "-pending"

    def entries():
        rows = [line.split() for line in reverse("--list").splitlines() if line.strip()]
        if any(len(row) != 3 for row in rows):
            raise HeadunitError("ADB returned an unreadable reverse mapping list.")
        return ([target for _, source, target in rows if source == key] for key in (device, marker))

    matches, markers = entries()
    if remove:
        # An ADB server restart can reuse a transport ID. Only our committed marker authorizes TCP removal.
        if markers == [host] and matches == [host]:
            reverse("--remove", device)
        if markers in ([host], [pending]):
            reverse("--remove", marker)
        return {"ok": True}
    if matches == [host]:
        return {"ok": True, "created": False}
    if matches:
        raise HeadunitError(f"{device} already has a different reverse mapping on the projecting phone.")
    reverse("--no-rebind", marker, pending)
    reverse("--no-rebind", device, host)
    matches, markers = entries()
    if matches != [host] or markers != [pending]:
        raise HeadunitError("The projecting phone's reverse mapping changed before it could be claimed.")
    try:
        reverse(marker, host)
    except HeadunitError:
        # This request received the successful TCP creation response and can undo it while its marker is present.
        matches, markers = entries()
        if matches == [host] and markers == [pending]:
            reverse("--remove", device)
        raise
    return {"ok": True, "created": True}


def projected_alert(unit, tree, data):
    from projected_alert import choose_alert, observe_alert

    observation = observe_alert(tree)
    if data["op"] == "alertPress":
        candidate = observation.get("candidate", {})
        chosen = choose_alert(candidate, data["action"])
        if data.get("fallback") is True and data["action"] == "dismiss":
            if chosen or not candidate or data.get("alert") != candidate.get("alert"):
                raise HeadunitError("The projected alert changed before Back could be sent.")
            return car_key(tree["serial"], 4)
        if not chosen or chosen["ref"] != data["ref"]:
            raise HeadunitError("The projected alert changed before the chosen button could be pressed.")
        return unit.press("ref=" + chosen["ref"], observed=tree)
    if observation["kind"] == "alert":
        candidate = observation["candidate"]
        nodes = {node["ref"]: node for node in tree["nodes"]}
        for action in ("accept", "dismiss"):
            chosen = choose_alert(candidate, action)
            if chosen:
                left, top, right, bottom = nodes[chosen["ref"]]["carBounds"]
                candidate[action] = dict(chosen, x=(left + right) // 2, y=(top + bottom) // 2)
    return {"ok": True, **observation}


def run(data):
    op = data["op"]
    if op == "appCatalog":
        from launcher import app_catalog

        return {"ok": True, **app_catalog(data.get("serial"), data.get("phoneAvd"))}
    if op == "portReverse":
        return port_reverse(data)
    if op == "pairStatus":
        from avd_pair import configured_pair_status
        return configured_pair_status([data.get("phoneAvd"), data.get("receiverAvd")])
    if op == "close" and data.get("target") in PROJECTION_TARGETS:
        # agent-device closes the active target before releasing its provider session.
        return {"ok": True}
    from headunit import Headunit

    serial = data.get("serial")
    unit = Headunit(serial)
    if op in {"keyboardStatus", "keyboardDismiss", "keyboardEnter"}:
        return keyboard(unit.connection, op)
    gestures = {"tap", "longPress", "swipe"}
    ref_operations = gestures | {"gesturePlan"}
    needs_nodes = op in {"snapshot", "field", "type", "clear", "alertObservation", "alertPress"} or (
        op in ref_operations and data.get("expectedRef") is not None)
    try:
        tree = (unit.connection.snapshot(include_screen_reader=True)
                if op == "snapshot" and data.get("includeScreenReader") is True
                else unit.connection.snapshot(include_nodes=needs_nodes))
    except NoVisibleProjection:
        if op != "close" or not isinstance(serial, str) or not serial or serial != unit.connection.serial:
            raise
        tree = {"serial": serial, "displays": []}
    if op == "layout":
        receiver = receiver_serial(tree["serial"])
        emulators = all(adb(serial, "shell", "getprop", "ro.kernel.qemu").strip() == "1"
                        for serial in (tree["serial"], receiver))
        result = dict(tree, receiver=receiver, emulators=emulators)
        if data.get("pinTransports"):
            members = {tree["serial"], receiver}
            transports = re.findall(r"(?m)^(\S+)[ \t]+device[ \t]+[^\r\n]*?\btransport_id:([1-9]\d*)\b",
                                    adb(None, "devices", "-l"))
            selected = [(serial, identifier) for serial, identifier in transports if serial in members]
            if len(selected) == len(members) and {serial for serial, _ in selected} == members:
                result["transports"] = dict(selected)
            if emulators and "transports" in result:
                avds = {serial: adb(serial, "shell", "getprop", "ro.boot.qemu.avd_name",
                                    transport_id=result["transports"][serial]).strip() for serial in members}
                if len(set(avds.values())) == len(members) and all(
                        re.fullmatch(r"[A-Za-z0-9_.][A-Za-z0-9_.-]*", name) for name in avds.values()):
                    result["avds"] = avds
        return result
    if op == "snapshot":
        return tree
    if op == "appstate":
        if data.get("receiver"):
            from avd_pair import PORT, forwarding
            receiver_serial(tree["serial"], data["receiver"])
            if forwarding() != [(tree["serial"], PORT, PORT)]:
                raise HeadunitError("The configured pair has no active projection forward.")
        return projected_app_state(tree)
    if op in {"alertObservation", "alertPress"}:
        return projected_alert(unit, tree, data)
    if op == "gesturePlan":
        from gesture_surface import display_gesture
        plan = display_gesture(tree["displays"], data["frames"])
        if data.get("expectedRef"):
            panel, x, y = point(tree["displays"], data["frames"][0]["events"][0])
            guard_touch_ref(tree, data["expectedRef"], panel, x, y, data.get("expectedFieldId"), data.get("expectedPressId"))
        return {"ok": True, "plan": plan}
    if op in {"field", "type", "clear"}:
        field = projected_field(tree)
        if op == "field":
            return {"ok": True, "field": ({"id": field["fieldId"], "bounds": field["carBounds"]} if field else None)}
        if not field or (data.get("id") is not None and data["id"] != field["fieldId"]):
            raise HeadunitError("The projected text field no longer has focus.")
        value = "" if op == "clear" else data.get("text")
        if not isinstance(value, str):
            raise HeadunitError("Expected text for the projected field.")
        action = "setText" if op == "clear" else "insertText"
        if "\b" in value:
            if value.strip("\b"):
                raise HeadunitError("Send projected Backspace separately from other text.")
            action = "deleteText"
        from renderer import read_windows
        records = list(window_records(adb(tree["serial"], "shell", "dumpsys", "window", "windows")))
        read_windows(tree["serial"], tree["displays"], records,
                     dict(field["rendererTarget"], action=action, text=value,
                          projectedEditor=tree["keyboardVisible"] and any(
                              p.get("receivesKeyboard") and p["id"] == field["display"] for p in tree["displays"])))
        return {"ok": True}
    if op in {"back", "home"}:
        return car_key(tree["serial"], 4 if op == "back" else 3)
    if op == "appSwitcher":
        show_launcher(unit, tree)
        return {"ok": True}
    if op == "mediaKey" and data.get("keycode") in (85, 87, 88, 89, 90):
        return car_key(tree["serial"], data["keycode"])
    if op in gestures:
        return gesture(tree, data)
    if op == "screenshot":
        return screenshot(tree)
    if op == "open":
        target = data["target"]
        if target in PROJECTION_TARGETS:
            return {"ok": True, "serial": tree["serial"]}
        return open_projected_app(unit, tree, target)
    if op == "deepLink":
        from projected_lifecycle import open_deep_link
        return open_deep_link(unit, tree, data.get("target"), data["url"], open_projected_app,
                              data.get("arguments", ()), relaunch=data.get("relaunch") is True)
    if op == "openWithExtras":
        from projected_lifecycle import open_with_extras
        return open_with_extras(unit, tree, data["target"], data["arguments"], open_projected_app,
                                relaunch=data.get("relaunch") is True, activity=data.get("activity"))
    if op == "resolveApp":
        from projected_lifecycle import resolve_app
        return resolve_app(unit, tree, data["target"], data.get("arguments"), data.get("activity"))
    if op == "relaunch":
        from projected_lifecycle import relaunch_app
        return relaunch_app(unit, tree, data["target"], open_projected_app)
    if op == "close":
        from projected_lifecycle import close_app
        return close_app(unit, tree, data["target"])
    raise HeadunitError(f"The projection does not implement {op}.")


MAX_REQUEST_BYTES = 6 * 1024 * 1024


def rpc_reply(request):
    try:
        return run(json.loads(request.decode("utf-8")))
    except (HeadunitError, ValueError, KeyError, TypeError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


def main():
    result = rpc_reply(sys.stdin.buffer.read(MAX_REQUEST_BYTES))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 1


def worker():
    from renderer import keep_renderer_sessions

    # Subprocesses must not read requests or write into the reply stream.
    with (os.fdopen(os.dup(sys.stdin.fileno()), "rb") as requests,
          os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8") as replies,
          open(os.devnull, "rb") as empty_input, keep_renderer_sessions()):
        os.dup2(empty_input.fileno(), sys.stdin.fileno())
        os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
        while request := requests.readline(MAX_REQUEST_BYTES + 1):
            if len(request) > MAX_REQUEST_BYTES or not request.endswith(b"\n"):
                print(json.dumps({"ok": False, "error": "Invalid Headunit request frame."}), file=replies, flush=True)
                return 1
            print(json.dumps(rpc_reply(request), ensure_ascii=False), file=replies, flush=True)
    return 0
