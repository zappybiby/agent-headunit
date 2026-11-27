"""Read installed AVD names and hardware from the emulator's configuration files."""

import os
from pathlib import Path
import subprocess
import sys


def properties(path):
    values = {}
    for line in path.read_text("utf-8-sig").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip()
    return values


def inventory(emulator):
    names = subprocess.check_output([emulator, "-list-avds"], text=True, timeout=20).splitlines()
    user = Path(os.environ.get("ANDROID_USER_HOME") or Path(os.environ.get("ANDROID_SDK_HOME") or Path.home()) / ".android")
    roots = [Path(os.environ.get("ANDROID_EMULATOR_HOME") or user) / "avd", user / "avd", Path.home() / ".android/avd"]
    if os.environ.get("ANDROID_AVD_HOME"):
        roots.insert(0, Path(os.environ["ANDROID_AVD_HOME"]))
    devices = {}
    for name in names:
        for root in dict.fromkeys(roots):
            ini = root / (name + ".ini")
            if not ini.is_file():
                continue
            location = properties(ini)
            paths = [root / (name + ".avd")]
            if location.get("path.rel"):
                paths.insert(0, user / location["path.rel"])
            if location.get("path"):
                paths.insert(0, Path(location["path"]))
            config = next((p / "config.ini" for p in paths if (p / "config.ini").is_file()), None)
            if config:
                values = properties(config)
                devices[name] = (values.get("abi.type", ""), values.get("tag.id", ""))
                break
    return devices


def choose_pair(devices, phone, receiver, saved):
    if len(devices) < 2:
        raise ValueError("Create a phone and a receiver AVD first. See 'Create the emulators' in the Windows quick start.")
    for name in (phone, receiver):
        if name and name not in devices:
            raise ValueError(f"Unknown AVD {name!r}. Installed: {', '.join(devices)}.")
    if phone and phone == receiver:
        raise ValueError("Choose different AVDs for the phone and the receiver.")

    def choose(role, requested, excluded):
        names = [name for name in devices if name != excluded]
        if requested:
            return requested
        previous = saved.get(role + "Avd")
        if previous in names:
            return previous
        if len(names) == 1:
            return names[0]
        if not sys.stdin.isatty():
            raise ValueError(f"Specify --{role}-avd. Installed AVDs: {', '.join(names)}.")
        print(f"Select the {role} AVD:")
        for index, name in enumerate(names, 1):
            abi, tag = devices[name]
            print(f"  {index}. {name}  {abi} {tag}")
        while True:
            answer = input(f"{role.capitalize()} name or number: ").strip()
            if answer in names:
                return answer
            if answer.isascii() and answer.isdecimal() and 1 <= int(answer) <= len(names):
                return names[int(answer) - 1]

    phone = choose("phone", phone, receiver)
    return phone, choose("receiver", receiver, phone)
