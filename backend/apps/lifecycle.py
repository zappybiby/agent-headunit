"""Control the Android owner of an app on the active car screen."""

import re
import shlex
import time

from apps.launcher import component_labels, launcher_apps
from projection.displays import COMPONENT, GEARHEAD, projection_displays
from projection.connection import HeadunitError, NoVisibleProjection, STARTUP_SERVICE, adb, window_records


_RECEIVER_PACKAGES = {"com.andrerinas.headunitrevived", "com.andrerinas.openheadunit"}
_PACKAGE = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+")
_URL = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*):([^\s\x00-\x1f\x7f]+)")
_WEB_SCHEMES = {"http", "https", "ws", "wss", "ftp", "ftps"}
_WAIT_SECONDS = 8
_MATCH_DEFAULT_ONLY = "65536"
_INTENT_EXTRA_ARGS = {
    "-e": 2, "--es": 2, "--esn": 1, "--ez": 2, "--ei": 2, "--el": 2, "--ef": 2,
    "--eu": 2, "--ecn": 2, "--eia": 2, "--eial": 2, "--ela": 2, "--elal": 2,
    "--efa": 2, "--efal": 2, "--esa": 2, "--esal": 2,
}
_INTENT_ACTIVITY_FLAGS = {
    "--activity-clear-top", "--activity-exclude-from-recents", "--activity-no-animation",
    "--activity-no-history", "--activity-reorder-to-front", "--activity-single-top",
}


def _component(value):
    match = COMPONENT.fullmatch(value)
    if not match:
        return None
    package, name = match.groups()
    if name.startswith("."):
        name = package + name
    elif "." not in name:
        name = package + "." + name
    return f"{package}/{name}"


def _catalog_app(unit, tree, target):
    serial = tree["serial"]
    if serial != unit.connection.serial:
        raise HeadunitError("The active projection changed phones.")
    if not isinstance(target, str) or not target.strip():
        raise HeadunitError("Specify a projected Android app name, package or component.")
    target = target.strip()
    package, sep, _ = target.partition("/")
    component = _component(target) if sep else None
    if sep and (not component or not _PACKAGE.fullmatch(package)):
        raise HeadunitError("Specify a projected Android app package or component.")
    if package == GEARHEAD or package in _RECEIVER_PACKAGES:
        raise HeadunitError("Use the projection session lifecycle for Android Auto and Open Headunit.")
    apps = [app for app in launcher_apps(serial)["apps"] if app["profile"] == "PERSONAL"
            and app["package"] not in _RECEIVER_PACKAGES | {GEARHEAD}]
    if _PACKAGE.fullmatch(package):
        candidates = [app for app in apps if app["package"] == package
                      and (component is None or app["component"] == component)]
    else:
        service = adb(serial, "shell", "dumpsys", "activity", "service", STARTUP_SERVICE)
        processes = set(re.findall(r"(?m)^SERVICE " + re.escape(STARTUP_SERVICE) + r"[^\n]*?\bpid=([1-9]\d*)\b", service))
        if len(processes) != 1:
            raise HeadunitError("Android Auto did not report its app catalog process. Specify the app package.")
        labels = component_labels(serial, int(processes.pop()), apps)
        components = {label["component"] for label in labels if label["label"].casefold() == target.casefold()}
        candidates = [app for app in apps if app["component"] in components]
    if len(candidates) != 1:
        raise HeadunitError(f"Android Auto did not report one personal launcher component for {target!r}.")
    return candidates[0]


def resolve_app(unit, tree, target, arguments=None, activity=None):
    app = _catalog_app(unit, tree, target)
    if arguments:
        intent_extras(arguments)
    if arguments or activity is not None:
        _verify_activity_launch(tree["serial"], app)
    if activity is not None:
        _explicit_activity(tree["serial"], app["package"], activity)
    foreground = any(panel["owner"] == app["package"] and panel.get("appFocused") for panel in tree["displays"])
    return {"ok": True, "package": app["package"], "component": app["component"], "foreground": foreground}


def intent_extras(arguments):
    if not isinstance(arguments, list) or not all(
            isinstance(arg, str) and "\x00" not in arg for arg in arguments):
        raise HeadunitError("Provide Android Intent extras as strings.")
    result = []
    position = 0
    while position < len(arguments):
        flag = arguments[position]
        count = _INTENT_EXTRA_ARGS.get(flag)
        if flag in _INTENT_ACTIVITY_FLAGS:
            count = 0
        if count is None or position + count >= len(arguments) or (count and not arguments[position + 1]):
            raise HeadunitError("Use complete Android Intent extras or activity flags that preserve the projected task.")
        result.extend([flag, *(shlex.quote(arg) for arg in arguments[position + 1:position + 1 + count])])
        position += 1 + count
    return result


def _display_identity(panel):
    return panel["id"], panel["owner"], panel["name"], panel.get("uniqueId")


def _phone_displays(serial):
    return projection_displays(adb(serial, "shell", "dumpsys", "display"), include_unbound=True)


def _service_display_ids(serial, component):
    dump = adb(serial, "shell", "dumpsys", "activity", "service", shlex.quote(component))
    services = re.split(r"(?m)^SERVICE ([\w.]+/[\w.$]+)[^\n]*\n", dump)
    return {int(number) for name, body in zip(services[1::2], services[2::2])
            if _component(name) == component
            for number in re.findall(r"(?m)^    display:Display id (\d+):", body)}


def _app_displays(tree, app):
    component, package = app["component"], app["package"]
    owned = [panel for panel in _phone_displays(tree["serial"]) if panel["owner"] == package]
    if not owned:
        return set()
    if app["native"]:
        matches = {panel["id"] for panel in owned if panel.get("activity") == component}
    else:
        visible = {_display_identity(panel): panel for panel in tree["displays"]}
        matches = {panel["id"] for panel in owned if
                   visible.get(_display_identity(panel), panel).get("components") == [component]}
        if len(owned) != len(matches):
            declared = _service_display_ids(tree["serial"], component)
            matches.update(panel["id"] for panel in owned if not panel.get("activity") and panel["id"] in declared)
    if any(panel["id"] not in matches for panel in owned):
        raise HeadunitError(f"Android Auto could not attribute all of {package}'s car displays to {component}.")
    return matches


def _package_pids(serial, package):
    processes = adb(serial, "shell", "ps", "-A", "-o", "PID,NAME")
    if not re.match(r"[ \t]*PID[ \t]+NAME[ \t]*(?:\r?\n|$)", processes):
        raise HeadunitError("Android did not report the app process list.")
    return {int(pid) for pid, name in re.findall(r"(?m)^[ \t]*(\d+)[ \t]+(\S+)[ \t]*\r?$", processes)
            if name == package or name.startswith(package + ":")}


def _close_running_app(tree, app):
    serial, package = tree["serial"], app["package"]
    displays = _app_displays(tree, app)
    pids = _package_pids(serial, package)
    if not displays and not pids:
        return False
    adb(serial, "shell", "am", "force-stop", "--user", "current", package)
    deadline = time.monotonic() + _WAIT_SECONDS
    while True:
        displays.update(panel["id"] for panel in _phone_displays(serial) if panel["owner"] == package)
        windows = adb(serial, "shell", "dumpsys", "window", "windows")
        if not any(display in displays and owner == package for _, (display, owner), _ in window_records(windows)):
            if not pids.intersection(_package_pids(serial, package)):
                return True
        if time.monotonic() >= deadline:
            raise HeadunitError(f"{package} did not close on the projected screen.")
        time.sleep(0.15)


def close_app(unit, tree, target):
    app = _catalog_app(unit, tree, target)
    return {"ok": True, "package": app["package"], "component": app["component"],
            "closed": _close_running_app(tree, app)}


def _wait_for_projection(unit, deadline):
    while True:
        try:
            return unit.connection.snapshot(include_nodes=False)
        except NoVisibleProjection:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(0.15, remaining))


def relaunch_app(unit, tree, target, open_projected_app):
    app = _catalog_app(unit, tree, target)
    _close_running_app(tree, app)
    deadline = time.monotonic() + _WAIT_SECONDS
    current = _wait_for_projection(unit, deadline)
    result = open_projected_app(unit, current, app["component"])
    while True:
        current = _wait_for_projection(unit, deadline)
        panels = [panel for panel in current["displays"] if panel["owner"] == app["package"]
                  and panel.get("appFocused") and (panel.get("activity") == app["component"]
                                                   or panel.get("components") == [app["component"]])]
        if panels:
            return {**result, "package": app["package"], "component": app["component"]}
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise HeadunitError(f"{app['component']} did not reopen on the projected screen.")
        time.sleep(min(0.15, remaining))


def resumed_activities(serial, display):
    dump = adb(serial, "shell", "dumpsys", "activity", "activities")
    displays = re.split(r"(?m)^[ \t]*Display #(\d+) \(activities from top to bottom\):[ \t]*\r?$", dump)
    return {(_component(component), int(task)) for number, body in zip(displays[1::2], displays[2::2])
            if int(number) == display
            for component, task in re.findall(
                r"(?m)^[ \t]*(?:Resumed:|mResumedActivity[:=]|topResumedActivity[:=])[ \t]*"
                r"ActivityRecord\{\S+ u\d+ (\S+) t(\d+)\b", body)}


def _display_is_current(serial, panel):
    return any(_display_identity(current) == _display_identity(panel)
               and current.get("activity") == panel["activity"] for current in _phone_displays(serial))


def _native_panel(tree, component, package):
    candidates = [panel for panel in tree["displays"] if panel.get("activity") == component
                  and panel["owner"] == package and panel.get("appFocused") and panel.get("uniqueId")]
    if len(candidates) > 1:
        raise HeadunitError("Android Auto reported multiple displays for the selected activity.")
    return candidates[0] if candidates else None


def _verify_activity_launch(serial, app):
    if not app["native"]:
        raise HeadunitError("This projected car app does not expose an Android activity for launch arguments or links.")
    feature = "android.software.activities_on_secondary_displays"
    if adb(serial, "shell", "pm", "has-feature", feature).strip() != "true":
        raise HeadunitError("Android does not support activity launches on secondary displays.")


def _activity_components(serial, command, intent, package=None, default_only=True):
    reply = adb(serial, "shell", "cmd", "package", command, "--components", "--user", "current",
                *(("--query-flags", _MATCH_DEFAULT_ONLY) if default_only else ()),
                *intent, *(("-p", package) if package else ()))
    return {component for line in reply.splitlines() if (component := _component(line.strip()))}


def _explicit_activity(serial, package, activity):
    if not isinstance(activity, str) or not activity.strip():
        raise HeadunitError("Specify an Android activity belonging to the projected app.")
    value = activity.strip()
    handler = _component(value if "/" in value else f"{package}/{value}")
    if not handler or handler.partition("/")[0] != package:
        raise HeadunitError("The requested activity must belong to the selected projected app.")
    if _activity_components(serial, "resolve-activity", ["-n", shlex.quote(handler)], default_only=False) != {handler}:
        raise HeadunitError(f"Android did not resolve the requested activity {handler}.")
    return handler


def _implicit_link(serial, intent):
    apps = [app for app in launcher_apps(serial)["apps"] if app["profile"] == "PERSONAL" and app["native"]
            and app["package"] not in _RECEIVER_PACKAGES | {GEARHEAD}]

    def matches(handlers):
        candidates = []
        for handler in handlers:
            owners = [app for app in apps if app["package"] == handler.partition("/")[0]]
            launcher = next((app for app in owners if app["component"] == handler), None)
            if launcher is not None or len(owners) == 1:
                candidates.append((launcher or owners[0], handler))
        return candidates

    preferred = matches(_activity_components(serial, "resolve-activity", intent))
    if len(preferred) == 1:
        return preferred[0]
    compatible = matches(_activity_components(serial, "query-activities", intent))
    if len(compatible) != 1:
        raise HeadunitError("Android did not resolve the URL to one projected activity. Specify the app with the URL.")
    return compatible[0]


def _start_projected_activity(unit, tree, app, handler, intent, launch):
    serial, package, component = tree["serial"], app["package"], app["component"]
    panel = _native_panel(tree, component, package)
    if panel is None and launch is not None:
        launch(unit, tree, component)
        deadline = time.monotonic() + _WAIT_SECONDS
        while panel is None and time.monotonic() < deadline:
            panel = _native_panel(unit.connection.snapshot(include_nodes=False), component, package)
            if panel is None:
                time.sleep(0.15)
    if panel is None:
        raise HeadunitError("Android Auto did not open the selected projected activity.")
    display = panel["id"]
    tasks = {task for activity, task in resumed_activities(serial, display)
             if activity and activity.partition("/")[0] == package}
    if len(tasks) != 1 or not _display_is_current(serial, panel):
        raise HeadunitError("The projected app activity or its display changed before launch.")
    task = tasks.pop()
    # Pin both the existing projected task and its display when starting the intent.
    reply = adb(serial, "shell", "am", "start", "-W", "--user", "current", "--display", str(display),
                "--task", str(task), *intent, "-n", shlex.quote(handler))
    warnings = re.findall(r"(?m)^Warning: (.+)$", reply)
    if not re.search(r"(?m)^Status: ok\r?$", reply) or any(
            not warning.startswith("Activity not started, intent has been delivered")
            for warning in warnings):
        raise HeadunitError("Android did not deliver the intent to the projected activity.")
    confirmed = resumed_activities(serial, display)
    launched = re.search(r"(?m)^Activity: (\S+)[ \t]*\r?$", reply)
    delivered = (handler, task) in confirmed
    if not delivered and launched and _component(launched[1]) == handler:
        delivered = any(resumed and resumed.startswith(package + "/") and current_task == task
                        for resumed, current_task in confirmed)
    if not delivered or not _display_is_current(serial, panel):
        raise HeadunitError("Android did not report the requested activity on the projected display.")
    return {"ok": True, "package": package, "component": handler, "display": display}


def open_with_extras(unit, tree, target, arguments, launch, relaunch=False, activity=None):
    extras = intent_extras(arguments)
    app = _catalog_app(unit, tree, target)
    serial = tree["serial"]
    _verify_activity_launch(serial, app)
    handler = app["component"] if activity is None else _explicit_activity(serial, app["package"], activity)
    if relaunch:
        _close_running_app(tree, app)
        tree = unit.connection.snapshot(include_nodes=False)
    intent = ["-a", "android.intent.action.MAIN", "-c", "android.intent.category.CAR_LAUNCHER"]
    return _start_projected_activity(unit, tree, app, handler, [*intent, *extras], launch)


def open_deep_link(unit, tree, target, url, launch=None, arguments=(), relaunch=False):
    serial = tree["serial"]
    if serial != unit.connection.serial:
        raise HeadunitError("The active projection changed phones.")
    value = url.strip() if isinstance(url, str) else ""
    parsed = _URL.fullmatch(value)
    if not parsed or parsed[1].lower() in _WEB_SCHEMES and not parsed[2].startswith("//"):
        raise HeadunitError("Provide a valid app deep link URL.")
    extras = intent_extras(arguments) if arguments else []
    intent = ["-a", "android.intent.action.VIEW", "-d", shlex.quote(value)]
    if target is None:
        app, handler = _implicit_link(serial, intent)
    else:
        app = _catalog_app(unit, tree, target)
    if not app["native"]:
        if extras:
            raise HeadunitError("Android launch arguments require a projected activity.")
        from apps.service_links import open_service_link
        return open_service_link(unit, tree, app, value, launch, relaunch=relaunch)
    package = app["package"]
    _verify_activity_launch(serial, app)
    if target is not None:
        handlers = _activity_components(serial, "resolve-activity", intent, package)
        if len(handlers) != 1 or not (handler := handlers.pop()).startswith(package + "/"):
            raise HeadunitError(f"{package} did not resolve the URL to one of its own activities.")
    if relaunch:
        _close_running_app(tree, app)
        tree = unit.connection.snapshot(include_nodes=False)
    return _start_projected_activity(unit, tree, app, handler, [*intent, *extras], launch)
