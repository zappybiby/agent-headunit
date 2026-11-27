"""Discover active Android Auto panels from the phone's logical display records."""

import math
import re
from collections import defaultdict


GEARHEAD = "com.google.android.projection.gearhead"
TOUCH_IME = GEARHEAD + ":TouchInputMethod"
GEARHEAD_TOOLTIP = GEARHEAD + ":Tooltip"
FACET_BAR = GEARHEAD + ":GhFacetBar"
LAUNCHER_WINDOW = "GhAppLauncherService"
COMPONENT = re.compile(r"([A-Za-z][\w.]*)/(\.?[A-Za-z_$][\w.$]*)", re.ASCII)
DISPLAY_INFO = re.compile(r'DisplayInfo\{"([^"]+)", displayId (\d+), (.*)')
DISPLAY_SIZE = re.compile(r"(?:^|, )real (\d+) x (\d+),")
LOGICAL_DENSITY = re.compile(r", density ([1-9]\d*) \([^,()]+\) dpi,")


def _component_name(owner, service):
    if service.startswith("."):
        service = owner + service
    elif "." not in service:
        service = owner + "." + service
    return owner + "/" + service


class AmbiguousWindow(ValueError):
    def __init__(self, message, components):
        super().__init__(message)
        self.components = components


def projection_displays(dump: str, *, include_unbound=False) -> list[dict]:
    """Return Gearhead panels and presentation windows owned by its active car apps."""
    displays = {}
    overrides = {}
    services = defaultdict(set)
    enabled = True
    section_id = None
    for raw_line in dump.splitlines():
        line = raw_line.strip()
        section = re.fullmatch(r"Display (\d+):", line)
        if section:
            section_id = int(section[1])
            enabled = True
        elif line.startswith("mIsEnabled="):
            enabled = line == "mIsEnabled=true"
        elif enabled and section_id is not None and line.startswith("mOverrideDisplayInfo="):
            value = line.split("=", 1)[1]
            if value != "null":
                overrides[section_id] = DISPLAY_INFO.fullmatch(value)
        elif enabled and line.startswith("mBaseDisplayInfo=DisplayInfo{"):
            info = DISPLAY_INFO.fullmatch(line.removeprefix("mBaseDisplayInfo="))
            if not info:
                continue
            name, display_id, properties = info.groups()
            number = int(display_id)
            if number == 0 or ", type VIRTUAL," not in properties or ", state ON," not in properties:
                continue
            owner_field = re.search(r", owner ([\w.]+) \(uid \d+\)", properties)
            if not owner_field:
                continue
            owner = owner_field[1]
            native_activity = None
            if owner == GEARHEAD:
                native = re.fullmatch(r"NativeDisplay:ComponentInfo\{([^}]+)\}", name)
                if native:
                    activity = COMPONENT.fullmatch(native[1])
                    if not activity or ", FLAG_TRUSTED," not in properties:
                        continue
                    native_activity = _component_name(*activity.groups())
                    owner = activity[1]
                ghost = re.fullmatch(r"GhostActivityDisplay:ComponentInfo\{([^}]+)\}", name)
                component = COMPONENT.fullmatch(ghost[1]) if ghost else None
                if component:
                    services[component[1]].add(_component_name(*component.groups()))
                if name == "LayoutDisplay" or name.startswith("GhostActivityDisplay"):
                    continue
            elif not (name.startswith(owner + "/") and ", FLAG_PRIVATE," in properties
                      and ", FLAG_PRESENTATION," in properties):
                continue
            size = DISPLAY_SIZE.search(properties)
            if size:
                displays[number] = {
                    "id": number, "name": name, "state": "ON", "owner": owner,
                    "width": int(size[1]), "height": int(size[2]),
                }
                density = LOGICAL_DENSITY.search(properties)
                if density:
                    displays[number]["densityDpi"] = int(density[1])
                if native_activity:
                    displays[number]["activity"] = native_activity
                unique_id = re.search(r', uniqueId "([^"]+)"', properties)
                if unique_id:
                    displays[number]["uniqueId"] = unique_id[1]
    panels = []
    for _, panel in sorted(displays.items()):
        if panel["id"] in overrides:
            override = overrides[panel["id"]]
            size = DISPLAY_SIZE.search(override[3]) if override else None
            density = LOGICAL_DENSITY.search(override[3]) if override else None
            if (size and density and int(override[2]) == panel["id"]
                    and (int(size[1]), int(size[2])) == (panel["width"], panel["height"])):
                panel["densityDpi"] = int(density[1])
            else:
                panel.pop("densityDpi", None)
        owner = panel["owner"]
        if panel["name"].startswith(owner + "/"):
            if owner in services:
                panel["components"] = sorted(services[owner])
            elif not include_unbound:
                continue
        panels.append(panel)
    return panels


def _render_layers(manager):
    """Read rows in paint order, excluding background diagnostics and historical logs."""
    _, start, body = manager.partition("Windows by layout z -- the order used for rendering:")
    table, end, _ = body.partition("Active windows by z -- order used for focus:")
    if not start or not end:
        raise ValueError("Android Auto did not report the current car display layout.")
    layers = []
    for line in table.splitlines():
        if "{name=" not in line:
            continue
        if ",vis=false," in line or ",surface=null," in line:
            continue
        name = re.search(r"\{name=([^,]+),region=", line)
        alpha = re.search(r",a=([0-9.]+),", line)
        vertices = re.search(r",vertices=\[(-?\d+), (-?\d+), (-?\d+), (-?\d+)\]", line)
        if not (name and alpha and vertices and ",vis=true," in line):
            raise ValueError("Android Auto reported an incomplete projection window.")
        rect = tuple(map(int, vertices.groups()))
        if float(alpha[1]) > 0 and rect[2] > rect[0] and rect[3] > rect[1]:
            opaque = float(alpha[1]) == 1 and ",transparencyEnabled=false," in line
            layers.append((name[1], rect, opaque))
    return layers


def _subtract(rect, cover):
    """Split the part outside an overlapping rectangle into disjoint rectangles."""
    left, bottom, right, top = rect
    x1, y1 = max(left, cover[0]), max(bottom, cover[1])
    x2, y2 = min(right, cover[2]), min(top, cover[3])
    if x1 >= x2 or y1 >= y2:
        return [rect]
    pieces = [(left, bottom, right, y1), (left, y2, right, top),
              (left, y1, x1, y2), (x2, y1, right, y2)]
    return [part for part in pieces if part[0] < part[2] and part[1] < part[3]]


def _match_panel(panels, name, rect, bindings):
    components = {
        component for p in panels for component in p.get("components", ())
        if component.rsplit(".", 1)[-1] == name and component.startswith(p["owner"] + "/")
        and COMPONENT.fullmatch(component)
    }
    candidates = [p for p in panels if (p.get("activity") and p["name"] == name)
                  or p["owner"] + ":" + p["name"] == name
                  or components.intersection(p.get("components", ()))]
    bound = [p for p in candidates if any((c, p["id"]) in bindings for c in components)]
    if len(bound) > 1:
        raise ValueError(f"Multiple services report an Android display for car window {name!r}.")
    if len(bound) == 1:
        return bound[0]
    if len(candidates) == 1 and len(candidates[0].get("components", ())) > 1:
        raise AmbiguousWindow(f"Multiple app services could own Android display {candidates[0]['id']}.", components)
    if len(candidates) > 1:
        same_size = [p for p in candidates if (p["width"], p["height"])
                     == (rect[2] - rect[0], rect[3] - rect[1])]
        if not components and len(same_size) == 1:
            return same_size[0]
        ids = ", ".join(str(p["id"]) for p in candidates)
        raise AmbiguousWindow(f"Car window {name!r} matches multiple Android displays ({ids}).", components)
    return candidates[0] if candidates else None


def _local_regions(regions, rect, panel):
    left, bottom, right, top = rect
    xs = panel["width"] / (right - left)
    ys = panel["height"] / (top - bottom)
    # The compositor measures y from the bottom and Android views measure y from the top.
    local = [
        [math.ceil((x1 - left) * xs), math.ceil((top - y2) * ys),
         math.floor((x2 - left) * xs), math.floor((top - y1) * ys)]
        for x1, y1, x2, y2 in regions
    ]
    return [r for r in local if r[0] < r[2] and r[1] < r[3]]


def _app_under_facet_bar(panels):
    def visible_area(panel):
        left, top, right, bottom = panel["carBounds"]
        visible_pixels = sum((x2 - x1) * (y2 - y1) for x1, y1, x2, y2 in panel["visibleRegions"])
        return visible_pixels * (right - left) * (bottom - top) / (panel["width"] * panel["height"])

    apps = [panel for panel in panels if panel["hitRegions"] and (panel.get("activity") or panel.get("components"))]
    foreground = max(apps, key=lambda panel: (visible_area(panel), panel["z"]), default=None)
    if foreground is None:
        return None
    launcher = next((panel for panel in apps if panel["owner"] == GEARHEAD and panel["carWindow"] == LAUNCHER_WINDOW), None)
    if launcher and launcher["z"] > foreground["z"]:
        return launcher
    return foreground


def visible_panels(panels: list[dict], service_dump: str) -> list[dict]:
    """Return visible panels with rectangles in each panel's local Android pixels."""
    visible = {}
    covers = []
    input_covers = []
    managers = re.split(r"(?m)^[ \t]*-- ProjectionWindowManager for display CarDisplayId\{displayId=(\d+)\}",
                        service_dump)
    main = [report for number, report in zip(managers[1::2], managers[2::2]) if number == "0"]
    if len(main) != 1:
        raise ValueError("Android Auto did not identify one current car display layout.")
    manager = main[0]
    bindings = set()
    services = re.split(r"(?m)^SERVICE ([\w.]+)/([\w.$]+)[^\n]*\n", service_dump)
    for owner, component, body in zip(services[1::3], services[2::3], services[3::3]):
        # A projected app's own service report identifies its presentation display directly.
        display_ids = set(re.findall(r"(?m)^    display:Display id (\d+):", body))
        if len(display_ids) == 1:
            bindings.add((_component_name(owner, component), int(display_ids.pop())))
    panels = list(panels)
    for index, panel in enumerate(panels):
        prefix = panel["owner"] + "/"
        if panel["name"].startswith(prefix):
            reported = {component for component, display in bindings
                        if display == panel["id"] and component.startswith(prefix)}
            if reported:
                panels[index] = dict(panel, components=sorted(reported.union(panel.get("components", ()))))
    params = re.search(r"Display #0\s+DisplaySourceService\s+DisplayParams\([^\n]*?"
                       r"dispWidth=(\d+), dispHeight=(\d+)", service_dump)
    if not params:
        raise ValueError("Android Auto did not report the primary car display dimensions.")
    viewport = tuple(map(int, params.groups()))
    if min(viewport) <= 0:
        raise ValueError("Android Auto reported an empty car display.")
    focus_regions = defaultdict(list)
    current = re.search(r"(?m)^\s*Current focus region:[^\n]*?\{name=([^,\n]+),", manager)
    history = re.search(r"(?m)^\s*Focus history: ([^\r\n]+)", manager)
    order = history[1].split() if history else []
    focused_window = current[1] if current else None
    app_window = focused_window
    transient = {TOUCH_IME, GEARHEAD_TOOLTIP}
    if focused_window in transient:
        app_window = None
        if order and order[-1] == focused_window:
            app_window = next((name for name in reversed(order[:-1]) if name not in transient), None)
    editor_window = app_window if focused_window == TOUCH_IME else None
    focus = re.search(r"(?m)^[ \t]*Focusable windows:([^\r\n]*)", manager)
    if focus:
        for key, x1, y1, x2, y2 in re.findall(
                r"\(([^,()]+), Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)\)", focus[1]):
            focus_regions[key].append((int(x1), viewport[1] - int(y2), int(x2), viewport[1] - int(y1)))
    for z, (name, rect, opaque) in reversed(list(enumerate(_render_layers(manager)))):
        clips = focus_regions.get(name) or [(0, 0, *viewport)]
        regions = []
        for clip in clips:
            clipped = (max(rect[0], clip[0]), max(rect[1], clip[1]),
                       min(rect[2], clip[2]), min(rect[3], clip[3]))
            if clipped[0] < clipped[2] and clipped[1] < clipped[3]:
                regions.append(clipped)
        for cover in covers:
            regions = [part for region in regions for part in _subtract(region, cover)]
        hit_regions = regions
        for cover in input_covers:
            hit_regions = [part for region in hit_regions for part in _subtract(region, cover)]
        # Even a translucent surface can accept input. Reserve its area for the top surface.
        input_covers.append(rect)
        if opaque:
            covers.append(rect)
        if not regions:
            continue
        panel = _match_panel(panels, name, rect, bindings)
        if not panel:
            continue
        if panel["id"] in visible:
            raise ValueError(f"Multiple car windows match Android display {panel['id']}.")
        visible[panel["id"]] = {
            **panel, "carWindow": name, "z": z,
            "screen": {"width": viewport[0], "height": viewport[1]},
            "carBounds": [rect[0], viewport[1] - rect[3], rect[2], viewport[1] - rect[1]],
            "visibleRegions": _local_regions(regions, rect, panel),
            "hitRegions": _local_regions(hit_regions, rect, panel),
        }
        if name == editor_window:
            visible[panel["id"]]["receivesKeyboard"] = True
        if name == app_window and app_window != FACET_BAR:
            visible[panel["id"]]["appFocused"] = True
    result = [panel for _, panel in sorted(visible.items()) if panel["visibleRegions"]]
    if app_window == FACET_BAR and any(panel["carWindow"] == FACET_BAR for panel in result):
        foreground = _app_under_facet_bar(result)
        if foreground:
            foreground["appFocused"] = True
    return result


def resolve_visible_panels(panels, service_dump, read_service):
    """Consult an app's presentation report only when its car window cannot be identified."""
    owners = {p["owner"] for p in panels if p["name"].startswith(p["owner"] + "/") and not p.get("components")}
    # Android 17 can start a projected service without creating its ghost activity display.
    inspected = {
        _component_name(owner, component)
        for owner, component in re.findall(
            r"\bstartInfo=StartInfo\{componentName=ComponentInfo\{([\w.]+)/([\w.$]+)\}, ghostActivity=null,",
            service_dump)
        if owner in owners
    }
    for component in sorted(inspected):
        service_dump += "\n" + read_service(component)
    while True:
        try:
            return visible_panels(panels, service_dump)
        except AmbiguousWindow as error:
            remaining = error.components - inspected
            if not remaining:
                raise
            for component in sorted(remaining):
                service_dump += "\n" + read_service(component)
                inspected.add(component)


def car_bounds(panel, local_bounds):
    """Map a panel rectangle into the car screen, with exclusive right and bottom edges."""
    x1, y1, x2, y2 = local_bounds
    if x1 > x2 or y1 > y2:
        raise ValueError("The local rectangle has inverted bounds.")
    left, top, right, bottom = panel["carBounds"]
    width, height = panel["width"], panel["height"]
    screen = panel["screen"]

    def edge(value, low, high, extent, limit):
        offset = math.ceil(min(extent, max(0, value)) * (high - low) / extent)
        return max(0, min(limit, low + offset))

    return [edge(x1, left, right, width, screen["width"]), edge(y1, top, bottom, height, screen["height"]),
            edge(x2, left, right, width, screen["width"]), edge(y2, top, bottom, height, screen["height"])]


def hit_panel(panels, x, y):
    """Return the foremost target panel and local pixel at a point on the car screen."""
    screens = {(p.get("serial"), p["screen"]["width"], p["screen"]["height"]) for p in panels}
    if len(screens) != 1:
        raise ValueError("The input target must contain panels from one car screen.")
    _, width, height = screens.pop()
    if not (0 <= x < width and 0 <= y < height):
        raise ValueError("The input point is outside the car screen.")
    for panel in sorted(panels, key=lambda p: p["z"], reverse=True):
        left, top, right, bottom = panel["carBounds"]
        if not (left <= x < right and top <= y < bottom):
            continue
        local_x = math.floor((x - left) * panel["width"] / (right - left))
        local_y = math.floor((y - top) * panel["height"] / (bottom - top))
        if any(x1 <= local_x < x2 and y1 <= local_y < y2 for x1, y1, x2, y2 in panel["hitRegions"]):
            return panel, local_x, local_y
    raise ValueError("The input point has no target on the visible car screen.")
