"""Publish projection snapshots to the accessibility bridge in the debug receiver."""

import json
import subprocess
import time

from projection.connection import Connection, HeadunitError, adb


RECEIVER = "com.andrerinas.headunitrevived.agent"
SCENE = "files/headunit-scene.json"


def publish(serial, message):
    # Both filenames are inside the debug receiver's private directory. Rename only after EOF.
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    cmd = ["adb", "-s", serial, "shell", "-T", "run-as", RECEIVER, "sh", "-c",
           "'cat > files/headunit-scene.tmp && mv files/headunit-scene.tmp files/headunit-scene.json'"]
    try:
        subprocess.run(cmd, input=payload, capture_output=True, timeout=10, check=True)
    except subprocess.CalledProcessError as error:
        raise HeadunitError((error.stderr or error.stdout).decode("utf-8", "replace").strip()) from error


def run(phone, receiver):
    if not phone or not receiver or phone == receiver:
        raise HeadunitError("Choose separate phone and receiver serials for the accessibility bridge.")
    adb(receiver, "shell", "run-as", RECEIVER, "mkdir", "-p", "files")
    unit = Connection(phone, None)
    status = None
    try:
        while True:
            start = time.monotonic()
            try:
                scene = unit.snapshot()
                state = "Mirroring the projected UI."
            except HeadunitError as error:
                state = str(error)
                scene = {"ok": False, "error": state}
            publish(receiver, scene)
            if state != status:
                print(state, flush=True)
                status = state
            time.sleep(max(0, 0.6 - (time.monotonic() - start)))
    finally:
        publish(receiver, {"ok": False})
