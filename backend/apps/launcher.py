"""List Android Auto launcher entries and open an app on the projected display."""

import re
import time

from emulators.receiver import car_key
from projection.displays import COMPONENT, GEARHEAD, LAUNCHER_WINDOW
from projection.connection import HeadunitError, StaleProjectedControl, adb, check_streaming_block, window_records


PACKAGE_NAME = re.compile(r"[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+", re.ASCII)
GEARHEAD_SERVICE = "com.google.android.projection.gearhead/.service.GearheadService"
_SECTION = "=== AVAILABLE_APP_FINDER ==="
_TABLE = "Last returned launcher components:"
_ROW = re.compile(
    r"\|\s*(?P<category>[A-Z_]+)\s*\|\s*ProjectionApp\(appKey=AppKey\("
    r"componentName=ComponentInfo\{(?P<package>[\w.]+)/(?P<class>[\w.$]+)\}, "
    r"profileType=(?P<profile>[A-Z_]+)\), appCategory=(?P<app_category>[A-Z_]+), "
    r"isParkedOnly=(?P<parked>true|false), isImmersiveApp=(?P<immersive>true|false), "
    r"isNativeApp=(?P<native>true|false)\)\s*\|"
)


def parse_launcher_apps(dump: str) -> dict:
    """Return the last finder result, without inferring visible entries or labels."""
    _, found, body = dump.partition(_SECTION)
    if not found:
        raise ValueError("Android Auto did not report AVAILABLE_APP_FINDER.")
    body = body.split("===", 1)[0]
    _, found, table = body.partition(_TABLE)
    if not found:
        raise ValueError("Android Auto did not report launcher components.")
    apps = []
    header = False
    for line in table.splitlines():
        line = line.strip()
        if not line.startswith("|"):
            if apps:
                break
            continue
        if line.startswith("|Category"):
            header = True
            continue
        match = _ROW.fullmatch(line)
        if not match or match["category"] != match["app_category"]:
            raise ValueError("Android Auto reported an unrecognized launcher component row.")
        package, cls = match["package"], match["class"]
        if cls.startswith("."):
            cls = package + cls
        elif "." not in cls:
            cls = package + "." + cls
        apps.append({
            "package": package,
            "component": package + "/" + cls,
            "profile": match["profile"],
            "category": match["category"],
            "parkedOnly": match["parked"] == "true",
            "immersive": match["immersive"] == "true",
            "native": match["native"] == "true",
        })
    if not header:
        raise ValueError("Android Auto did not report a launcher component table.")
    return {"source": "AVAILABLE_APP_FINDER", "apps": apps}


def launcher_apps(serial: str) -> dict:
    """Read the phone's most recent Android Auto launcher finder result."""

    dump = adb(serial, "shell", "dumpsys", "activity", "service", GEARHEAD_SERVICE)
    return parse_launcher_apps(dump)


def app_catalog(serial=None, phone_avd=None):
    """Read a known phone without bringing a projection or emulator up."""
    from projection.connection import Connection

    if phone_avd is not None:
        from emulators.pair import running_avds

        if (serial is not None or not isinstance(phone_avd, str) or
                not re.fullmatch(r"[A-Za-z0-9_.][A-Za-z0-9_.-]*", phone_avd)):
            raise HeadunitError("Select one running phone AVD for the Android Auto app catalog.")
        serial = running_avds((phone_avd,)).get(phone_avd)
        if serial is None:
            raise HeadunitError(f"Start the configured phone AVD {phone_avd} to read its Android Auto app catalog.")
    else:
        serial = Connection.connect(serial).serial

    try:
        return launcher_apps(serial)
    except ValueError as exc:
        raise HeadunitError(
            f"No readable Android Auto app catalog on {serial}. Connect the receiver to populate it. {exc}"
        ) from exc


def component_labels(serial: str, pid: int, apps: list[dict]) -> list[dict]:
    """Resolve component labels through the projecting phone's PackageManager."""
    from accessibility.renderer import java_agent, managed_device

    if type(pid) is not int or pid <= 0:
        raise ValueError("Invalid Android process ID.")
    entries = [{"component": app["component"], "profile": app["profile"], "native": app["native"]} for app in apps]
    agent = java_agent("component-labels")
    with managed_device(serial) as device:
        attachment = device.attach(pid)
        try:
            script = attachment.create_script(agent, name="component-labels")
            script.load()
            return script.exports_sync.labels(entries)
        finally:
            attachment.detach()


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
