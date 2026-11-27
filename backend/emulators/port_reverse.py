"""Manage ADB reverse mappings used by Metro on the projecting phone."""

import re

from projection.connection import HeadunitError, adb


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
