"""Dispatch requests from the agent-device provider to the Android backend."""

import json
import os
import re
import sys

from apps.launcher import open_projected_app, show_launcher
from controls.gestures import display_gesture, gesture, guard_touch_ref, point
from controls.keyboard import keyboard
from emulators.port_reverse import port_reverse
from emulators.receiver import RECEIVER, car_key, receiver_serial, screenshot
from projection.displays import GEARHEAD
from projection.connection import HeadunitError, NoVisibleProjection, adb, projected_field, window_records


PROJECTION_TARGETS = {GEARHEAD, RECEIVER, "Android Auto", "Open Headunit"}


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
        from apps.lifecycle import resumed_activities
        resumed = {activity.partition("/")[2] for activity, _ in resumed_activities(tree["serial"], panel["id"])
                   if activity and activity.partition("/")[0] == package}
        if len(resumed) == 1:
            result["activity"] = resumed.pop()
    return result


def projected_alert(unit, tree, data):
    from projection.alerts import choose_alert, observe_alert

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
        from apps.launcher import app_catalog

        return {"ok": True, **app_catalog(data.get("serial"), data.get("phoneAvd"))}
    if op == "portReverse":
        return port_reverse(data)
    if op == "pairStatus":
        from emulators.pair import configured_pair_status
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
            from emulators.pair import PORT, forwarding
            receiver_serial(tree["serial"], data["receiver"])
            if forwarding() != [(tree["serial"], PORT, PORT)]:
                raise HeadunitError("The configured pair has no active projection forward.")
        return projected_app_state(tree)
    if op in {"alertObservation", "alertPress"}:
        return projected_alert(unit, tree, data)
    if op == "gesturePlan":
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
        from accessibility.renderer import read_windows
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
        from apps.lifecycle import open_deep_link
        return open_deep_link(unit, tree, data.get("target"), data["url"], open_projected_app,
                              data.get("arguments", ()), relaunch=data.get("relaunch") is True)
    if op == "openWithExtras":
        from apps.lifecycle import open_with_extras
        return open_with_extras(unit, tree, data["target"], data["arguments"], open_projected_app,
                                relaunch=data.get("relaunch") is True, activity=data.get("activity"))
    if op == "resolveApp":
        from apps.lifecycle import resolve_app
        return resolve_app(unit, tree, data["target"], data.get("arguments"), data.get("activity"))
    if op == "relaunch":
        from apps.lifecycle import relaunch_app
        return relaunch_app(unit, tree, data["target"], open_projected_app)
    if op == "close":
        from apps.lifecycle import close_app
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
    from accessibility.renderer import keep_renderer_sessions

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
