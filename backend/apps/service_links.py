"""Deliver a URL to an active Android Auto app session."""

from collections import defaultdict
from contextlib import ExitStack
import re
import shlex
import time
from urllib.parse import unquote
from uuid import uuid4

from apps.launcher import GEARHEAD_SERVICE
from projection.displays import COMPONENT, FACET_BAR, GEARHEAD, GEARHEAD_TOOLTIP, LAUNCHER_WINDOW, TOUCH_IME
from accessibility.renderer import detach, java_agent, managed_device
from projection.connection import HeadunitError, STARTUP_SERVICE, adb, window_records


_MIN_HOST_MAJOR = 18
_CAR_APP_SERVICE = "androidx.car.app.CarAppService"
_SHELL_WINDOWS = {FACET_BAR, GEARHEAD_TOOLTIP, LAUNCHER_WINDOW, TOUCH_IME}
_MAPS_PACKAGE = "com.google.android.apps.maps"
_MAPS_WINDOW = "GmmCarProjectionService"
_MAPS_COMPONENT = _MAPS_PACKAGE + "/com.google.android.apps.gmm.car." + _MAPS_WINDOW
_MAPS_NAVIGATION_CLASS = "com.google.android.apps.gmm.car.androidauto.CarNavigationProviderService"
_MAPS_NAVIGATION_SERVICE = _MAPS_PACKAGE + "/" + _MAPS_NAVIGATION_CLASS
_MAPS_REQUEST_EXTRA = "S.com.androidlab.headunit.MAPS_LINK_REQUEST"
_MAPS_LOG_TIME = r"\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}"
_PRIMARY_REGION = r"CarRegionId\{regionId=([1-9]\d*) carDisplayId=CarDisplayId\{displayId=0\}\}"
_PRIMARY_MANAGER = re.compile(
    r"(?m)^[ \t]*-- ProjectionWindowManager for display CarDisplayId\{displayId=0\}[^\n]*\n"
    r"([\s\S]*?)(?=^[ \t]*-- ProjectionWindowManager for display|\Z)")


class AndroidxLinkUnavailable(HeadunitError):
    """The app did not receive a link and the caller may select a different route."""


def _check_support(serial, app):
    if app["profile"] != "PERSONAL":
        raise HeadunitError("Projected service links require a personal Android Auto app.")
    package, component = app["package"], app["component"]
    if not (COMPONENT.fullmatch(component) and component.startswith(package + "/") and package != GEARHEAD):
        raise HeadunitError("Specify the selected Android Auto app service.")
    if component == _MAPS_COMPONENT:
        if app["category"] != "NAVIGATION":
            raise HeadunitError("Android Auto did not catalog the selected Maps navigation service.")
    else:
        services = adb(serial, "shell", "cmd", "package", "query-services", "--components",
                       "--user", "current", "-a", _CAR_APP_SERVICE, "-p", package)
        candidates = {p + "/" + (p + name if name.startswith(".") else name)
                      for line in services.splitlines() if (match := COMPONENT.fullmatch(line.strip()))
                      for p, name in [match.groups()]}
        if component not in candidates:
            raise HeadunitError(f"{component} does not declare the AndroidX Car App Library service interface.")
    if adb(serial, "shell", "getprop", "ro.kernel.qemu").strip() != "1":
        raise HeadunitError("Projected service links require an authorized emulator.")


def _supports_host_links(serial):
    package = adb(serial, "shell", "dumpsys", "package", GEARHEAD)
    installed = re.search(r"(?m)^[ \t]*versionName=([^\r\n]*)", package)
    major = re.match(r"(\d+)(?:[.+-]|$)", installed[1].strip()) if installed else None
    return major is not None and int(major[1]) >= _MIN_HOST_MAJOR


def _primary_render(dump):
    managers = _PRIMARY_MANAGER.findall(dump)
    if len(managers) != 1:
        return None
    _, start, rows = managers[0].partition("Windows by layout z -- the order used for rendering:")
    render, end, _ = rows.partition("Active windows by z -- order used for focus:")
    return render if start and end else None


def _current_primary_regions(serial, dump, component):
    if not re.search(r"(?m)^[ \t]*Current app ProjectionApp\(", dump):
        dump = adb(serial, "shell", "dumpsys", "activity", "service", GEARHEAD_SERVICE)
    return set(re.findall(r"(?m)^[ \t]*Current app ProjectionApp\(appKey=AppKey\(componentName=ComponentInfo\{"
                          + re.escape(component) + r"\}, profileType=PERSONAL\),[^\r\n]*?\) on region "
                          + _PRIMARY_REGION + r"[ \t]*\r?$", dump))


def _current_user_and_host(serial):
    user = adb(serial, "shell", "am", "get-current-user").strip()
    if not re.fullmatch(r"\d+", user):
        raise AndroidxLinkUnavailable("Android did not identify the current user for the projected app.")
    packages = adb(serial, "shell", "cmd", "package", "list", "packages", "--user", user, "-U", GEARHEAD)
    uids = re.findall(r"(?m)^package:" + re.escape(GEARHEAD) + r" uid:([1-9]\d*)[ \t]*\r?$", packages)
    if len(uids) != 1:
        raise AndroidxLinkUnavailable("Android did not identify the installed Android Auto host for this user.")
    return int(user), int(uids[0])


def _service_pid(serial, component, user):
    package, _, name = component.partition("/")
    names = [component]
    if name.startswith("."):
        names.append(package + "/" + package + name)
    elif name.startswith(package + "."):
        names.append(package + "/" + name[len(package):])
    dump = adb(serial, "shell", "dumpsys", "activity", "service", shlex.quote(component))
    matches = re.findall(r"(?m)^[ \t]*SERVICE (?:" + "|".join(map(re.escape, names))
                         + r") [\da-f]+ pid=([1-9]\d*) user=" + str(user) + r"[ \t]*\r?$", dump)
    return int(matches[0]) if len(matches) == 1 else None


def _androidx_binding(tree, component, user):
    serial = tree["serial"]
    panels = [panel for panel in tree["displays"] if panel["owner"] == GEARHEAD
              and panel["id"] > 0 and panel.get("uniqueId") and panel.get("hitRegions")
              and panel["carWindow"] not in _SHELL_WINDOWS]
    if not panels:
        return None
    dump = adb(serial, "shell", "dumpsys", "activity", "service", STARTUP_SERVICE)
    rendered = _primary_render(dump)
    if rendered is None:
        return None
    regions = _current_primary_regions(serial, dump, component)
    layers = {(name, region) for name, region in re.findall(
        r"(?m)\{name=([^,\r\n]+),region=" + _PRIMARY_REGION + r",[^\r\n]*?,vis=true,[^\r\n]*?,surface=(?!null\b)\S+",
        rendered) if region in regions}
    bindings = [(int(region), panel["id"], panel["uniqueId"]) for panel in panels
                for name, region in layers if panel["carWindow"] == name]
    if len(bindings) != 1:
        return None
    pid = _service_pid(serial, component, user)
    return (pid, *bindings[0]) if pid is not None else None


def _dispatch_androidx(unit, tree, component, url, user, host_uid):
    serial = tree["serial"]
    binding = _androidx_binding(tree, component, user)
    if binding is None:
        return None
    pid, region, display, _ = binding
    agent = java_agent("projected-androidx-links")
    entered_delivery = False
    try:
        with managed_device(serial) as device:
            attachment = device.attach(pid)
            try:
                script = attachment.create_script(agent, name="projected-androidx-links")
                script.load()
                exports = script.exports_sync
                probe = exports.probe(component, host_uid)
                if not isinstance(probe, dict):
                    raise AndroidxLinkUnavailable("The AndroidX car session probe did not report a usable result.")
                if probe.get("status") == "inactive":
                    return None
                if probe.get("status") != "ready":
                    raise AndroidxLinkUnavailable(probe.get("error") or "The app does not expose an observable AndroidX car session.")
                match = probe.get("match")
                if not isinstance(match, dict) or (match.get("component"), match.get("pid"), match.get("hostUid")) != (
                        component, pid, host_uid):
                    raise AndroidxLinkUnavailable("The AndroidX car session did not match the selected service and host.")
                current = unit.connection.snapshot(include_nodes=False)
                if current["serial"] != serial or _androidx_binding(current, component, user) != binding:
                    return None
                entered_delivery = True
                reply = exports.deliver(component, host_uid, match, url)
            finally:
                attachment.detach()
    except ValueError as error:
        if entered_delivery:
            raise HeadunitError("The link may have reached the app before Android Auto stopped responding.") from error
        raise AndroidxLinkUnavailable("The projected car app could not expose its AndroidX session.") from error

    status = reply.get("status") if isinstance(reply, dict) else None
    if status == "inactive":
        return None
    if status == "unsupported":
        raise AndroidxLinkUnavailable(reply.get("error") or "The projected app cannot receive the link through AndroidX.")
    if status != "accepted":
        raise HeadunitError(reply.get("error") if isinstance(reply, dict) and reply.get("error")
                            else "Android Auto did not confirm whether the projected app received the link.")
    return {"ok": True, "package": component.partition("/")[0], "component": component,
            "display": display, "region": region, "method": "androidx-session"}


def _display_processes(tree):
    panels = {p["id"] for p in tree["displays"] if p["owner"] == GEARHEAD
              and p["id"] > 0 and p["hitRegions"] and p["carWindow"] not in _SHELL_WINDOWS}
    if not panels:
        return {}
    processes = defaultdict(set)
    records = adb(tree["serial"], "shell", "dumpsys", "window", "windows")
    for _, (display, owner), pid in window_records(records):
        if owner == GEARHEAD and display in panels and pid:
            processes[pid].add(display)
    return processes


def _dispatch(tree, component, url):
    processes = _display_processes(tree)
    if not processes:
        return None
    agent = java_agent("projected-service-links")
    with managed_device(tree["serial"]) as device, ExitStack() as attachments:
        matches = []
        for pid, displays in processes.items():
            session = device.attach(pid)
            attachments.callback(session.detach)
            script = session.create_script(agent, name="projected-service-links")
            script.load()
            exports = script.exports_sync
            match = exports.probe(component, sorted(displays))
            if match is not None:
                matches.append((exports, match))
        if len(matches) > 1:
            raise HeadunitError("Android Auto has more than one visible session for the selected service.")
        if not matches:
            return None
        exports, match = matches[0]
        reply = exports.deliver(component, match, url)
        if reply.get("status") != "submitted":
            raise HeadunitError(reply.get("error") or "Android Auto did not confirm submission through the template host.")
        return {"ok": True, "package": component.partition("/")[0], "component": component,
                "display": match["display"], "session": match["session"], "submitted": True,
                "nativeCompletion": False, "receipt": "template-host"}


def _maps_binding(tree):
    panels = [panel["id"] for panel in tree["displays"]
              if panel["owner"] == _MAPS_PACKAGE and panel["carWindow"] == _MAPS_WINDOW
              and panel.get("components") == [_MAPS_COMPONENT] and panel["hitRegions"]]
    if not panels:
        return None
    if len(panels) != 1:
        raise HeadunitError("Android Auto reported more than one visible Maps window.")
    serial, display = tree["serial"], panels[0]
    windows = adb(serial, "shell", "dumpsys", "window", "windows")
    pids = {pid for _, identity, pid in window_records(windows) if identity == (display, _MAPS_PACKAGE) and pid}
    dump = adb(serial, "shell", "dumpsys", "activity", "service", STARTUP_SERVICE)
    host = set(re.findall(r"(?m)^SERVICE " + re.escape(STARTUP_SERVICE) + r"[^\n]*?\bpid=([1-9]\d*)\b", dump))
    render = _primary_render(dump)
    if len(pids) != 1 or len(host) != 1 or render is None:
        raise HeadunitError("Android Auto did not report one primary host and visible Maps process.")
    rendered = set(re.findall(r"(?m)\{name=" + _MAPS_WINDOW + r",region=" + _PRIMARY_REGION
                              + r",[^\n]*?,vis=true,[^\n]*?,surface=(?!null\b)\S+", render))
    regions = rendered & _current_primary_regions(serial, dump, _MAPS_COMPONENT)
    if len(regions) != 1:
        raise HeadunitError("Android Auto did not identify one visible primary Maps region.")
    return int(host.pop()), int(regions.pop()), pids.pop()


def _maps_intent_log(serial, maps_pid, user):
    dump = adb(serial, "shell", "dumpsys", "-t", "2", "activity", "service", _MAPS_NAVIGATION_SERVICE)
    headers = re.compile(r"[ \t]*SERVICE (\S+) [a-f0-9]+ pid=([1-9]\d*) user=(\d+)[ \t]*")
    services = []
    for section in re.split(r"(?m)(?=^[ \t]*SERVICE )", dump):
        lines = section.splitlines()
        header = headers.fullmatch(lines[0]) if lines else None
        if header and header[1] == _MAPS_NAVIGATION_SERVICE and header[3] == user:
            services.append((int(header[2]), lines))
    if len(services) != 1 or services[0][0] != maps_pid:
        raise HeadunitError("Maps did not expose an intent log for the selected projected process.")
    lines = services[0][1]
    headings = [index for index, line in enumerate(lines)
                if re.fullmatch(r"[ \t]*Intent log @ " + _MAPS_LOG_TIME + r":[ \t]*", line)]
    if len(headings) != 1:
        raise HeadunitError("Maps did not expose an intent log for the selected projected process.")
    entries = []
    for line in lines[headings[0] + 1:]:
        entry = re.fullmatch(r"[ \t]+" + _MAPS_LOG_TIME + r" : (.*)", line)
        if not entry:
            break
        entries.append(entry[1])
    return entries


def _matches_maps_intent(entry, component, url, request):
    data, marker, trailer = entry.rpartition("#Intent;")
    if not marker or data != url or not trailer.endswith(";end"):
        return False
    tags = [part.partition("=") for part in trailer.removesuffix(";end").split(";")]
    fields = defaultdict(list)
    for key, separator, value in tags:
        if separator:
            fields[unquote(key)].append(unquote(value))
    return (fields["component"] == [component] and fields[_MAPS_REQUEST_EXTRA] == [request]
            and fields["action"] in ([], ["android.intent.action.VIEW"]))


def _dispatch_maps(tree, component, url):
    binding = _maps_binding(tree)
    if binding is None:
        return None
    manager_pid, region, maps = binding
    serial = tree["serial"]
    user = adb(serial, "shell", "am", "get-current-user").strip()
    router_pid = _service_pid(serial, GEARHEAD_SERVICE, int(user)) if user.isdecimal() else None
    if router_pid is None:
        raise HeadunitError("Android Auto did not identify its routing service for the current user.")
    agent = java_agent("projected-maps-links")
    with managed_device(serial) as device, ExitStack() as attachments:
        def attach(pid):
            session = device.attach(pid)
            attachments.callback(detach, session)
            script = session.create_script(agent, name="projected-maps-links")
            script.load()
            return script.exports_sync

        manager = attach(manager_pid)
        match = manager.probe(component, region, maps)
        if match is None:
            return None
        router = manager if router_pid == manager_pid else attach(router_pid)
        _maps_intent_log(serial, maps, user)
        if manager.probe(component, region, maps) != match:
            raise HeadunitError("The selected Maps projection changed.")
        request = str(uuid4())
        send_error = None
        try:
            router.send_link(component, url, request, match["router"])
        except Exception as error:
            send_error = error
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        entries = _maps_intent_log(serial, maps, user)
        if any(_matches_maps_intent(entry, component, url, request) for entry in entries):
            return {"ok": True, "package": _MAPS_PACKAGE, "component": component, "region": region,
                    "dispatched": True, "nativeCompletion": False, "receipt": "maps-on-new-intent"}
        time.sleep(0.15)
    if send_error:
        raise HeadunitError(str(send_error)) from send_error
    raise HeadunitError("Maps did not record the link in the selected projected process.")


def open_service_link(unit, tree, app, url, launch=None, relaunch=False):
    """Deliver through the selected app's existing primary car session."""
    if tree["serial"] != unit.connection.serial:
        raise HeadunitError("The active projection changed phones.")
    serial = tree["serial"]
    _check_support(serial, app)
    component = app["component"]
    host_links = _supports_host_links(serial)
    if component == _MAPS_COMPONENT:
        if url.partition(":")[0] not in {"geo", "google.navigation"}:
            raise HeadunitError("Projected Maps links require a geo: or google.navigation: URL.")
        if not host_links:
            raise HeadunitError(f"Projected Maps links require Android Auto {_MIN_HOST_MAJOR} or later.")

        def dispatch(current):
            return _dispatch_maps(current, component, url)
    else:
        try:
            user, host_uid = _current_user_and_host(serial)
        except AndroidxLinkUnavailable:
            if not host_links:
                raise
            user = host_uid = None

        def dispatch(current):
            if host_uid is not None:
                try:
                    result = _dispatch_androidx(unit, current, component, url, user, host_uid)
                except AndroidxLinkUnavailable:
                    if not host_links:
                        raise
                else:
                    if result is not None:
                        return result
            return _dispatch(current, component, url) if host_links else None

    if relaunch:
        from apps.lifecycle import close_app
        close_app(unit, tree, component)
        tree = unit.connection.snapshot(include_nodes=False)
    result = dispatch(tree)
    if result is not None:
        return result
    if launch is not None:
        launch(unit, tree, component)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            result = dispatch(unit.connection.snapshot(include_nodes=False))
            if result is not None:
                return result
            time.sleep(0.2)
    raise HeadunitError("Android Auto did not show a connected template session for the selected app.")
