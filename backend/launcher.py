"""Read the launcher candidates last returned by the Android Auto app finder."""

import re


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
    from transport import adb

    dump = adb(serial, "shell", "dumpsys", "activity", "service", GEARHEAD_SERVICE)
    return parse_launcher_apps(dump)


def app_catalog(serial=None, phone_avd=None):
    """Read a known phone without bringing a projection or emulator up."""
    from transport import Connection, HeadunitError

    if phone_avd is not None:
        from avd_pair import running_avds

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
    from renderer import java_agent, managed_device

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
