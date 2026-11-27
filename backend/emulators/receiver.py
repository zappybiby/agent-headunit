"""Find the Open Headunit receiver, send car keys, and capture its display."""

import base64
from io import BytesIO
import os
import re

from projection.connection import HeadunitError, adb


RECEIVER = "com.andrerinas.headunitrevived"


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
