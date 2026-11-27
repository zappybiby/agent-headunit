"""Configure agent-headunit for an installed emulator pair on Windows."""

import argparse
from contextlib import contextmanager, nullcontext
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv

from assets import frida_server, release_file, resolve_release
from avds import choose_pair, inventory


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from emulators.pair import emulator_executable, running_avds
from emulators.receiver import RECEIVER
from projection.connection import HeadunitError, adb


@contextmanager
def setup_lock(directory):
    import msvcrt
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".agent-headunit-setup.lock").open("a+b") as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise ValueError(f"Another setup is using {directory}. Retry when it finishes.") from error
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def runtime(data, pins):
    identity = hashlib.sha256(pins.encode("utf-8") + os.fsencode(sys.base_prefix)
                              + sys.implementation.cache_tag.encode()).hexdigest()[:16]
    directory = data / "runtimes" / identity
    python = directory / "Scripts/python.exe"
    ready = directory / ".installed"
    if not (python.is_file() and ready.is_file()):
        venv.EnvBuilder(with_pip=True).create(directory)
        requirements = directory / "requirements.txt"
        requirements.write_text(pins, "utf-8")
        subprocess.run([python, "-m", "pip", "install", "-r", requirements], check=True)
        ready.touch()
    version = subprocess.check_output([python, "-I", "-c", "import frida; print(frida.__version__)"], text=True).strip()
    return python, version


def install_receiver(serial, cache, asset, local_apk):
    if local_apk is None and "package:" + RECEIVER in adb(serial, "shell", "pm", "list", "packages", RECEIVER).splitlines():
        print(f"Open Headunit is already installed on {serial}.")
        return
    apk = local_apk or release_file(cache, asset)
    subprocess.run(["adb", "-s", serial, "install", "-r", str(apk)], check=True)
    if "package:" + RECEIVER not in adb(serial, "shell", "pm", "list", "packages", RECEIVER).splitlines():
        raise ValueError(f"The APK did not install the expected receiver package {RECEIVER} on {serial}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-avds", action="store_true", help="list installed AVDs and exit")
    parser.add_argument("--phone-avd", help="rooted Android Auto phone AVD")
    parser.add_argument("--receiver-avd", help="Open Headunit receiver AVD")
    parser.add_argument("--install-receiver", action="store_true", help="install Open Headunit on the running receiver if missing")
    parser.add_argument("--receiver-apk", type=Path, help="install your own Open Headunit APK on the selected receiver")
    parser.add_argument("--data-dir", type=Path, default=Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "agent-headunit")
    args = parser.parse_args()
    devices = inventory(emulator_executable())
    if args.list_avds:
        for name, (abi, tag) in devices.items():
            print(f"{name}\t{abi}\t{tag}")
        if not devices:
            print("No installed AVDs found.")
        return

    manifest_file = ROOT / "package.json"
    manifest = json.loads((manifest_file if manifest_file.exists() else ROOT / "provider/package.json").read_text("utf-8"))
    if os.name != "nt" or not shutil.which("agent-device"):
        raise ValueError(f"Install agent-device on Windows: npm install -g agent-device@{manifest['devDependencies']['agent-device']}")
    home = Path(os.environ.get("AGENT_DEVICE_HOME") or Path.home() / ".agent-device").resolve()
    config = home / "config.json"
    plugins = json.loads(config.read_text("utf-8-sig")).get("plugins", {}) if config.exists() else {}
    saved = plugins.get(manifest["name"], {}).get("options", {})
    phone, receiver = choose_pair(devices, args.phone_avd, args.receiver_avd, saved)
    lock = ROOT / "windows/assets.json"
    requirements = ROOT / "backend/requirements.txt"
    if lock.is_file():
        pins = requirements.read_text("utf-8")
        assets = json.loads(lock.read_text("utf-8"))
    else:
        pins, assets = resolve_release(manifest["openHeadunit"], requirements)
    abi = devices[phone][0]
    if abi not in assets["servers"]:
        raise ValueError(f"No Android Frida server for phone ABI {abi!r}.")
    receiver_serial = None
    if args.install_receiver or args.receiver_apk:
        if args.receiver_apk and not args.receiver_apk.is_file():
            raise ValueError(f"Receiver APK not found: {args.receiver_apk}")
        receiver_serial = running_avds([receiver]).get(receiver)
        if not receiver_serial:
            raise ValueError(f"Start {receiver}, wait for the home screen, then repeat setup to install Open Headunit.")

    data = args.data_dir.expanduser().resolve()
    cache = data / "downloads"
    print(f"Phone: {phone} ({devices[phone][0]}). Receiver: {receiver}.", flush=True)
    with setup_lock(data):
        python, version = runtime(data, pins)
        if version != assets["fridaVersion"]:
            raise ValueError(f"Frida {version} does not match the release server {assets['fridaVersion']}.")
        server = frida_server(cache, assets["servers"][abi])
        if receiver_serial:
            install_receiver(receiver_serial, cache, assets["receiver"], args.receiver_apk)
        installer = ROOT / "install_provider.py" if manifest_file.is_file() else ROOT / "scripts/install_provider.py"
        with setup_lock(home) if home != data else nullcontext():
            subprocess.run([python, "-B", installer, home, "--phone-avd", phone, "--receiver-avd", receiver,
                            "--frida-server", server, *(["--with-audio"] if saved.get("audio") else [])], check=True)
    print("Ready. Run agent-device connect headunit --platform android.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, EOFError, ValueError, subprocess.CalledProcessError, HeadunitError) as error:
        sys.exit(str(error))
