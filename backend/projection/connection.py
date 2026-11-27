"""Read Android's native window trees and send input to their projection displays."""

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import os
from pathlib import Path
import re
import shutil
import shlex
import subprocess
import time
from zipfile import BadZipFile, ZipFile

from accessibility.panels import accessible_windows, match_window_roots, render_panels
from accessibility.native_nodes import window_nodes
from projection.displays import GEARHEAD, TOUCH_IME, car_bounds, projection_displays, resolve_visible_panels
from accessibility.window_tree import HierarchyError, decode_window


# The Windows SDK installer does not put its tools on PATH.
if os.name == "nt":
    sdk = Path(os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") or
               Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Android/Sdk")
    os.environ["PATH"] = os.pathsep.join((os.environ.get("PATH", ""), str(sdk / "platform-tools"), str(sdk / "emulator")))


class HeadunitError(RuntimeError):
    """A phone, projected element or requested operation is unavailable."""


class SceneChanged(HeadunitError):
    """The projected window changed before the read completed."""


class NoVisibleProjection(HeadunitError):
    """The selected projection has no matching visible panel."""


class StaleProjectedControl(HeadunitError):
    """The Frida guard rejected the target before dispatch."""


STARTUP_SERVICE = GEARHEAD + "/com.google.android.apps.auto.carservice.service.impl.GearheadCarStartupService"
BLOCKED_STREAMING_WINDOW = "com.android.internal.app.BlockedAppStreamingActivity"


def adb(serial, *args, binary=False, transport_id=None):
    path = shutil.which("adb")
    if not path:
        raise HeadunitError("ADB was not found. Activate Android Lab or add platform-tools to PATH.")
    cmd = [path]
    if transport_id is not None:
        cmd.extend(("-t", transport_id))
    elif serial:
        cmd.extend(("-s", serial))
    try:
        p = subprocess.run([*cmd, *args], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HeadunitError(f"ADB could not complete {args[0]} on {serial or 'the host'}: {exc}") from exc
    if p.returncode:
        reason = (p.stderr or p.stdout).decode("utf-8", "replace").strip()
        raise HeadunitError(f"ADB {args[0]} failed on {serial or 'the host'}: {reason}")
    return p.stdout if binary else p.stdout.decode("utf-8", "replace")


def connected(serial):
    if serial:
        return [serial]
    if os.environ.get("ANDROID_SERIAL"):
        return [os.environ["ANDROID_SERIAL"]]
    return [line.split()[0] for line in adb(None, "devices").splitlines()
            if re.fullmatch(r"\S+\s+device", line.strip())]


def panels_on(serial):
    panels = projection_displays(adb(serial, "shell", "dumpsys", "display"), include_unbound=True)
    if not panels:
        return []
    service = adb(serial, "shell", "dumpsys", "activity", "service", STARTUP_SERVICE)
    try:
        def read_service(component):
            return adb(serial, "shell", "dumpsys", "activity", "service", shlex.quote(component))
        return [dict(panel, serial=serial) for panel in resolve_visible_panels(panels, service, read_service)]
    except ValueError as exc:
        raise SceneChanged(f"Could not identify the visible Android Auto panels: {exc}") from exc


def window_details(state):
    """Read the identity and bounds of each visible Android window."""
    for block in re.split(r"(?m)^\s*Window #\d+ Window\{", state)[1:]:
        header = re.match(r"(\w+) u\d+ (.+?)\}:\s*\n", block)
        display = re.search(r"\bmDisplayId=(\d+)\b", block)
        owner = re.search(r"\bmOwnerUid=\d+[^\n]*?\bpackage=([^\s]+)", block)
        if not (header and display and owner and re.search(r"(?m)^\s*isVisible=true\s*$", block)):
            continue
        session = re.search(r"\bmSession=Session\{\S+ (\d+):", block)
        frame = re.search(r"(?m)^\s*Frames:[^\n]*?\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]", block)
        kind = re.search(r"(?m)^\s*mAttrs=\{[^\n]*?\bty=([A-Z_]+)\b", block)
        yield (f"{header[1]} {header[2]}", (int(display[1]), owner[1]), int(session[1]) if session else None,
               list(map(int, frame.groups())) if frame else None, kind[1] if kind else None)


def window_records(state):
    """Map archive entry names to the actual display and owner of each visible window."""
    for key, identity, pid, _, _ in window_details(state):
        yield key, identity, pid


def check_streaming_block(panels, records):
    blocked = {display for title, (display, owner), _ in records
               if owner == "android" and title and title.endswith(BLOCKED_STREAMING_WINDOW)}
    for panel in panels:
        if panel["id"] in blocked:
            raise HeadunitError(f"Android blocked {panel['owner']} from opening on car display {panel['id']}.")


def window_map(state):
    return {key: identity for key, identity, _ in window_records(state)}


def collect_nodes(panels, windows, archive):
    targets = {p["id"]: p for p in panels}
    mapped = window_map(windows) if isinstance(windows, str) else windows
    nodes = []
    decoded = set()
    try:
        with ZipFile(BytesIO(archive)) as z:
            for entry in z.infolist():
                display, owner = mapped.get(entry.filename, (None, None))
                panel = targets.get(display)
                if panel and panel["owner"] == owner:
                    if not entry.file_size:
                        raise SceneChanged(f"Android returned an empty view hierarchy for {panel['name']} on display {display}.")
                    root = decode_window(z.read(entry))
                    controls = window_nodes(root, panel, entry.filename)
                    for node in controls:
                        node["carBounds"] = car_bounds(panel, node["bounds"])
                        if node.get("pressBounds"):
                            node["carPressBounds"] = car_bounds(panel, node["pressBounds"])
                        if node.get("scrollBounds"):
                            node["carScrollBounds"] = car_bounds(panel, node["scrollBounds"])
                    nodes.extend(controls)
                    decoded.add(display)
    except (BadZipFile, HierarchyError) as exc:
        raise SceneChanged(f"Android returned an incomplete window hierarchy: {exc}") from exc
    missing = [p["name"] for p in panels if p["id"] not in decoded]
    if missing:
        raise SceneChanged("The projected windows changed or have no native hierarchy: " + ", ".join(missing))
    return nodes


def press_point(node, hit):
    if not hit or hit["window"] != node["window"]:
        raise HeadunitError("The selected element moved. Take a fresh snapshot.")
    left, top, right, bottom = hit["bounds"]
    regions = []
    for x1, y1, x2, y2 in node["pressRegions"]:
        bounds = (max(x1, left), max(y1, top), min(x2, right), min(y2, bottom))
        if bounds[0] < bounds[2] and bounds[1] < bounds[3]:
            regions.append(bounds)
    if not regions:
        raise HeadunitError("Another control covers the selected element.")
    x1, y1, x2, y2 = max(regions, key=lambda r: (r[2] - r[0]) * (r[3] - r[1]))
    return [(x1 + x2) // 2, (y1 + y2) // 2]


def projected_field(tree):
    fields = [n for n in tree["nodes"] if n.get("fieldId") and n["enabled"]]
    targets = {p["id"] for p in tree["displays"] if p.get("receivesKeyboard")}
    if tree["keyboardVisible"] and targets:
        editors = [n for n in fields if n["display"] in targets]
        if editors:
            focused = [n for n in editors if n["focused"]] or editors
            return focused[0] if len(focused) == 1 else None
    focused = [n for n in fields if n["focused"]]
    return focused[0] if len(focused) == 1 else None


class Connection:
    def __init__(self, serial, display):
        self.serial = serial
        self.display = display

    @staticmethod
    def displays(serial=None):
        return [p for phone in connected(serial) for p in panels_on(phone)]

    @classmethod
    def connect(cls, serial=None, display=None):
        devices = connected(serial)
        if not devices:
            raise HeadunitError("No phone is connected through ADB.")
        # A selected phone may reconnect or change its active panels between commands.
        if len(devices) == 1:
            return cls(devices[0], display)
        phones = [phone for phone in devices if projection_displays(adb(phone, "shell", "dumpsys", "display"))]
        if len(phones) != 1:
            if not phones:
                raise HeadunitError("No active Android Auto projection. Connect the receiver to the phone.")
            raise HeadunitError("Multiple phones are projecting. Use --serial with one of: " + ", ".join(phones))
        return cls(phones[0], display)

    def snapshot(self, *, include_nodes=True, include_screen_reader=False):
        for attempt in range(3):
            try:
                return self._snapshot(include_nodes, include_screen_reader)
            except (SceneChanged, NoVisibleProjection) as error:
                if attempt == 2 or (isinstance(error, NoVisibleProjection) and not include_nodes):
                    raise
                time.sleep(0.1)

    def _snapshot(self, include_nodes, include_screen_reader=False):
        panels = panels_on(self.serial)
        if self.display is not None:
            panels = [p for p in panels if p["id"] == self.display]
        if not panels:
            raise NoVisibleProjection("No matching visible Android Auto panel. Check the Open Headunit connection and retry.")
        scene = {"ok": True, "serial": self.serial, "displays": panels,
                 "keyboardVisible": any(p.get("carWindow") == TOUCH_IME for p in panels),
                 "viewport": {"x": 0, "y": 0, **panels[0]["screen"]}}
        if not include_nodes:
            return scene
        if os.environ.get("HEADUNIT_FRIDA_SESSION"):
            from accessibility.renderer import read_windows
            details = list(window_details(adb(self.serial, "shell", "dumpsys", "window", "windows")))
            records = [(key, identity, pid) for key, identity, pid, _, _ in details]
            check_streaming_block(panels, records)
            windows = {key: identity for key, identity, _ in records}
            geometry = {key: (frame, kind) for key, _, _, frame, kind in details}
            try:
                roots = (read_windows(self.serial, panels, records, include_screen_reader=True)
                         if include_screen_reader else read_windows(self.serial, panels, records))
                scene["nodes"] = [node for panel in sorted(render_panels(panels, records), key=lambda p: p["z"])
                                  for node in match_window_roots([w for w in roots if w["display"] == panel["id"]],
                                                                 panel, windows, geometry)]
                field = projected_field(scene)
                scene["activeField"] = {"id": field["fieldId"], "bounds": field["carBounds"]} if field else None
            except ValueError as exc:
                raise SceneChanged(str(exc)) from exc
            return scene
        presentations = [panel for panel in panels if not panel.get("activity")]
        nodes = []
        if presentations:
            with ThreadPoolExecutor(max_workers=1) as pool:
                archive = pool.submit(adb, self.serial, "exec-out", "cmd", "window", "dump-visible-window-views", binary=True)
                windows = window_map(adb(self.serial, "shell", "dumpsys", "window", "windows"))
                nodes.extend(collect_nodes(presentations, windows, archive.result()))
        else:
            windows = window_map(adb(self.serial, "shell", "dumpsys", "window", "windows"))
        for panel in panels:
            if panel.get("activity"):
                try:
                    nodes.extend(accessible_windows(adb, self.serial, panel, windows))
                except ValueError as exc:
                    raise SceneChanged(f"Could not read projected activity {panel['activity']}: {exc}") from exc
        order = {p["id"]: p["z"] for p in panels}
        nodes.sort(key=lambda node: order[node["display"]])
        scene["nodes"] = nodes
        return scene

    def request(self, op, *, observed=None, **args):
        tree = observed if observed is not None else self.snapshot()
        if observed is not None and (tree["serial"] != self.serial or op not in {"press", "scroll"}):
            raise HeadunitError("The captured control belongs to another projection action.")
        if op == "snapshot":
            return tree
        target = args.get("target")
        node = next((n for n in tree["nodes"] if n["ref"] == target), None)
        if not node or not node["enabled"]:
            raise HeadunitError("The element changed or disappeared. Take a fresh snapshot.")
        if observed is not None and not node.get("rendererTarget"):
            raise HeadunitError("The captured control needs live renderer validation.")
        action = "scroll-" + args["direction"] if op == "scroll" else op
        if action not in node["actions"]:
            raise HeadunitError(f"The current element does not support {action}.")
        if node.get("rendererTarget") and op in {"press", "scroll"}:
            from accessibility.renderer import read_windows
            records = list(window_records(adb(self.serial, "shell", "dumpsys", "window", "windows")))
            method = args["direction"] if op == "scroll" else "press"
            try:
                read_windows(self.serial, tree["displays"], records, dict(node["rendererTarget"], action=method))
            except ValueError as exc:
                raise HeadunitError(str(exc)) from exc
            return {"ok": True, "action": action, "ref": target, "display": node["display"]}
        display = str(node["display"])
        if op == "press":
            hit = next((n for n in tree["nodes"] if n["ref"] == args.get("hit")), None)
            gesture = ["tap", *press_point(node, hit)]
        elif op == "scroll":
            left, top, right, bottom = node["scrollBounds"]
            x, y = (left + right) // 2, (top + bottom) // 2
            horizontal = node.get("scrollAxis") == "horizontal"
            first, last = (left, right) if horizontal else (top, bottom)
            margin = max(1, (last - first) // 5)
            start, end = last - margin - 1, first + margin
            if start <= end:
                raise HeadunitError("The scrolling element has too little visible space for a swipe.")
            if args["direction"] == "backward":
                start, end = end, start
            gesture = ["swipe", start, y, end, y, 350] if horizontal else ["swipe", x, start, x, end, 350]
        else:
            raise HeadunitError(f"Unknown operation {op}.")
        adb(self.serial, "shell", "input", "-d", display, *map(str, gesture))
        return {"ok": True, "action": action, "ref": target, "display": node["display"]}
