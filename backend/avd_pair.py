"""Start and connect two prepared Android emulators."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import time

from agent_rpc import RECEIVER, receiver_serial
from projection import GEARHEAD
from transport import Connection, HeadunitError, adb


PORT = "tcp:5277"
SERVER_FLOW = Path(__file__).with_name("start-server.yaml")


def running_avds(names, closed=None):
    check_owner(closed)
    serials = re.findall(r"(?m)^(emulator-\d+)[ \t]+device\b", adb(None, "devices"))
    found = {}
    for serial in serials:
        check_owner(closed)
        try:
            name = adb(serial, "shell", "getprop", "ro.boot.qemu.avd_name").strip()
            if not name:
                name = adb(serial, "emu", "avd", "name").splitlines()[0].strip()
        except (HeadunitError, IndexError):
            continue
        if name in names:
            if name in found:
                raise HeadunitError(f"More than one emulator reports AVD {name}.")
            found[name] = serial
    return found


def emulator_executable():
    executable = shutil.which("emulator")
    if not executable:
        raise HeadunitError("Add the Android SDK emulator directory to PATH.")
    return executable


def configured_pair_status(names):
    if len(names) != 2 or not all(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.][A-Za-z0-9_.-]*", name)
                                  for name in names) or names[0] == names[1]:
        raise HeadunitError("Specify two distinct installed AVDs.")
    members = dict.fromkeys(names)
    rows = adb(None, "devices", "-l").splitlines()
    if not rows or rows[0].strip() != "List of devices attached":
        raise HeadunitError("Could not read the local ADB inventory.")
    for row in rows[1:]:
        if not (match := re.fullmatch(r"(emulator-[1-9]\d*)\s+(\S+)(.*)", row.strip())):
            continue
        serial, state, fields = match.groups()
        name = adb(serial, "shell", "getprop", "ro.boot.qemu.avd_name").strip() if state == "device" else ""
        if not name:
            console = adb(serial, "emu", "avd", "name").strip().splitlines()
            if len(console) != 2 or console[1] != "OK" or not console[0]:
                raise HeadunitError(f"Could not identify the AVD on {serial}.")
            name = console[0]
        if name not in members:
            continue
        transport = re.search(r"\btransport_id:([1-9]\d*)\b", fields)
        if members[name] is not None or transport is None:
            raise HeadunitError(f"Could not identify a unique ADB transport for {name}.")
        booted = state == "device" and adb(serial, "shell", "getprop", "sys.boot_completed").strip() == "1"
        members[name] = {"serial": serial, "transportId": transport[1], "booted": booted}
    missing = [name for name, member in members.items() if member is None]
    if missing:
        executable = emulator_executable()
        listed = subprocess.run([executable, "-list-avds"], capture_output=True, text=True, timeout=12, check=True)
        if absent := set(missing).difference(listed.stdout.splitlines()):
            raise HeadunitError("AVDs not installed: " + ", ".join(sorted(absent)))
    return {"ok": True, "members": [members[name] for name in names]}


def check_owner(closed):
    if closed is not None and closed.is_set():
        raise HeadunitError("The owner closed the Open Headunit startup.")


def boot_avds(names, processes, *, audio=False, closed=None):
    found = running_avds(names, closed)
    missing = set(names).difference(found)
    if missing:
        emulator = emulator_executable()
        listed = subprocess.run([emulator, "-list-avds"], capture_output=True, text=True, timeout=20, check=True)
        if unknown := missing.difference(listed.stdout.splitlines()):
            raise HeadunitError("AVDs not installed: " + ", ".join(sorted(unknown)))
        for name in names:
            if name in missing:
                check_owner(closed)
                audio_args = [] if audio and name == names[1] else ["-no-audio"]
                processes[name] = subprocess.Popen(
                    [emulator, "-avd", name, "-no-window", "-gpu", "host", *audio_args],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
                    start_new_session=True,
                )
    deadline = time.monotonic() + 240
    ready = set()
    while time.monotonic() < deadline:
        current = running_avds(names, closed)
        ready.intersection_update(name for name in current if current[name] == found.get(name))
        found = current

        def booted(name):
            try:
                return adb(found[name], "shell", "getprop", "sys.boot_completed").strip() == "1"
            except HeadunitError:
                return False

        pending = tuple(found.keys() - ready)
        if pending:
            with ThreadPoolExecutor(max_workers=len(pending)) as executor:
                ready.update(name for name, done in zip(pending, executor.map(booted, pending)) if done)
        if ready == set(names):
            return tuple(found[name] for name in names)
        if exited := [name for name, process in processes.items()
                      if process.poll() is not None and name not in found]:
            raise HeadunitError("Android Emulator exited while starting " + ", ".join(exited) + ".")
        time.sleep(0.5)
    raise HeadunitError("AVDs still starting after four minutes: " + ", ".join(sorted(set(names) - ready)))


def phone_sockets(phone, flags):
    try:
        return adb(phone, "shell", "ss", flags)
    except HeadunitError:
        su = adb(phone, "shell", "command -v su || test ! -x /debug_ramdisk/su || echo /debug_ramdisk/su").strip()
        if not su:
            raise
        return adb(phone, "shell", shlex.quote(su), "-c", shlex.quote(f"ss {flags}"))


def pair_is_projecting(phone, receiver):
    if not re.search(r"(?m)^ESTAB\s+\d+\s+\d+\s+\S+:5277\s", phone_sockets(phone, "-tn")):
        return False
    try:
        receiver_serial(phone, receiver)
        Connection.connect(phone).snapshot(include_nodes=False)
    except HeadunitError:
        return False
    return True


def connect_pair(phone, receiver, closed=None):
    check_owner(closed)
    if pair_is_projecting(phone, receiver):
        return
    if not re.search(r"(?m)^LISTEN\s+\d+\s+\d+\s+\S+:5277\s", phone_sockets(phone, "-ltn")):
        maestro = shutil.which("maestro")
        if not maestro:
            raise HeadunitError("Add Maestro to PATH or start the phone's Android Auto head unit server.")
        adb(phone, "shell", "am", "start", "-a", GEARHEAD + ".SETTINGS")
        with subprocess.Popen([maestro, "--device", phone, "test", str(SERVER_FLOW)], stdout=2) as process:
            deadline = time.monotonic() + 150
            try:
                while process.poll() is None and time.monotonic() < deadline:
                    check_owner(closed)
                    time.sleep(0.25)
            finally:
                if process.poll() is None:
                    process.kill()
            status = process.wait()
        if status:
            raise HeadunitError("Maestro could not start the phone's Android Auto head unit server.")
        if not re.search(r"(?m)^LISTEN\s+\d+\s+\d+\s+\S+:5277\s", phone_sockets(phone, "-ltn")):
            raise HeadunitError("The phone's Android Auto head unit server did not open port 5277.")
    check_owner(closed)
    adb(receiver, "shell", "am", "start", "-a", "com.andrerinas.openheadunit.ACTION_CONNECT",
        "-p", RECEIVER, "--es", "ip", "10.0.2.2")
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        check_owner(closed)
        if pair_is_projecting(phone, receiver):
            return
        time.sleep(0.5)
    raise HeadunitError(f"Android Auto did not project from {phone} to {receiver} within 90 seconds.")


def forwarding():
    return [tuple(fields) for line in adb(None, "forward", "--list").splitlines()
            if len(fields := line.split()) == 3 and fields[1] == PORT]


def rollback_avds(processes):
    failed = []
    for name, process in processes.items():
        try:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            failed.append(name)
    if failed:
        raise HeadunitError("Could not stop AVDs started by this allocation: " + ", ".join(failed))


@contextmanager
def prepare_pair(phone_avd, receiver_avd, *, adopted, audio=False, closed=None):
    check_owner(closed)
    if phone_avd == receiver_avd:
        raise HeadunitError("Choose separate phone and receiver AVD names.")
    if not all(re.fullmatch(r"[A-Za-z0-9_.-]+", name) and not name.startswith("-")
               for name in (phone_avd, receiver_avd)):
        raise HeadunitError("Specify installed AVD names from emulator -list-avds.")
    address = os.environ.get("ANDROID_ADB_SERVER_ADDRESS")
    socket = os.environ.get("ADB_SERVER_SOCKET")
    if address and address not in {"localhost", "127.0.0.1", "::1"} or socket and not re.fullmatch(
            r"(?:local(?:abstract|filesystem|reserved)?:.+|tcp:(?:(?:localhost|127\.0\.0\.1|\[::1\]):)?\d+)", socket):
        raise HeadunitError("Starting AVDs by name requires a local ADB server.")
    processes = {}
    try:
        phone, receiver = boot_avds((phone_avd, receiver_avd), processes, audio=audio, closed=closed)
        for serial, package in ((phone, GEARHEAD), (receiver, RECEIVER)):
            check_owner(closed)
            if not adb(serial, "shell", "pm", "path", package).strip().startswith("package:"):
                raise HeadunitError(f"Install {package} on {serial} before starting Open Headunit.")
        check_owner(closed)
        expected = [(phone, PORT, PORT)]
        current = forwarding()
        if current and current != expected:
            raise HeadunitError("Host port 5277 is already forwarded to another device or port.")
        if not current:
            adb(phone, "forward", "--no-rebind", PORT, PORT)
        try:
            connect_pair(phone, receiver, closed)
            yield phone, receiver
        finally:
            if not current and forwarding() == expected:
                adb(phone, "forward", "--remove", PORT)
    finally:
        if not adopted.is_set():
            rollback_avds(processes)
