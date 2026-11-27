"""Build the provider package or install it in a dedicated agent-device home."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
import uuid


INSTALLER = Path(__file__).resolve()
PACKAGED = (INSTALLER.parent / "package.json").is_file()
SOURCE = INSTALLER.parent if PACKAGED else INSTALLER.parents[1]


def package_files():
    provider = SOURCE if PACKAGED else SOURCE / "provider"
    backend = SOURCE / "backend"
    files = {
        "package.json": (provider / "package.json").read_bytes(),
        "LICENSE": (SOURCE / "LICENSE").read_bytes(),
        "install_provider.py": INSTALLER.read_bytes(),
    }
    for pattern in ("*.mjs", "cli/*.mjs"):
        for path in sorted(provider.glob(pattern)):
            files[path.relative_to(provider).as_posix()] = path.read_bytes()
    for pattern in ("*.py", "frida/*.js", "requirements.txt", "start-server.yaml"):
        for path in sorted(backend.glob(pattern)):
            files["backend/" + path.relative_to(backend).as_posix()] = path.read_bytes()
    touch_jar = "android/projected-touch.jar"
    if PACKAGED:
        files["backend/" + touch_jar] = (backend / touch_jar).read_bytes()
    else:
        from build_touch import build_touch_helper
        files["backend/" + touch_jar] = build_touch_helper(backend / "android" / "ProjectedTouch.java")
    return files


def write_package(destination, files):
    for name, contents in files.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)


def pack(output, *, env=None):
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise OSError("npm was not found on PATH.")
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output) as temporary:
        stage = Path(temporary)
        write_package(stage, package_files())
        subprocess.run([npm, "pack", "--ignore-scripts", "--pack-destination", str(output)],
                       cwd=stage, env=env, check=True)


def install(home, managed=None):
    files = package_files()
    manifest = json.loads(files["package.json"])
    digest = hashlib.sha256()
    for name, contents in files.items():
        digest.update(name.encode("utf-8") + b"\0" + hashlib.sha256(contents).digest())
    installation = str(uuid.UUID(bytes=digest.digest()[:16]))
    plugins = home / "plugins"
    destination = plugins / installation
    plugins.mkdir(parents=True, exist_ok=True)
    if not destination.is_dir():
        with TemporaryDirectory(dir=plugins) as tmp:
            project = Path(tmp) / "stage"
            out = project / "node_modules" / manifest["name"]
            write_package(out, files)
            try:
                os.rename(project, destination)
            except OSError:
                if not destination.is_dir():
                    raise
    config_path = home / "config.json"
    config = json.loads(config_path.read_text("utf-8-sig")) if config_path.exists() else {}
    entries = config.setdefault("plugins", {})
    options = dict(entries.get(manifest["name"], {}).get("options", {}))
    if not PACKAGED:
        options.update(backend=str(SOURCE / "backend" / "headunit.py"), python=sys.executable)
    if managed is not None:
        options["python"] = sys.executable
        options.update(managed)
        options.pop("serial", None)
    selection = {"installation": installation, **({"options": options} if options else {})}
    if entries.get(manifest["name"]) != selection:
        entries[manifest["name"]] = selection
        with TemporaryDirectory(dir=home) as tmp:
            staged = Path(tmp) / "config.json"
            staged.write_text(json.dumps(config, indent=2), "utf-8")
            staged.replace(config_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("home", nargs="?", type=Path, help="dedicated agent-device home directory")
    action.add_argument("--pack", type=Path, metavar="OUTPUT", help="write an npm tarball to OUTPUT")
    parser.add_argument("--phone-avd", help="rooted projecting AVD for stock agent-device boot")
    parser.add_argument("--receiver-avd", help="prepared Open Headunit receiver AVD")
    parser.add_argument("--frida-server", type=Path, help="uncompressed Frida server matching the phone and Python client")
    parser.add_argument("--with-audio", action="store_true", help="enable host audio when starting the receiver AVD")
    args = parser.parse_args()
    managed = None
    if args.phone_avd or args.receiver_avd or args.frida_server or args.with_audio:
        if args.pack:
            parser.error("Pair settings require an installation home.")
        if not args.phone_avd or not args.receiver_avd or args.phone_avd == args.receiver_avd:
            parser.error("Configure two distinct AVDs with --phone-avd and --receiver-avd.")
        if args.frida_server is None:
            parser.error("Specify the uncompressed Android Frida binary with --frida-server.")
        binary = args.frida_server.expanduser().resolve()
        if not binary.is_file():
            parser.error(f"No Frida server file was found at {binary}.")
        managed = {"phoneAvd": args.phone_avd, "receiverAvd": args.receiver_avd,
                   "fridaServer": str(binary), "audio": args.with_audio}
    try:
        if args.pack:
            pack(args.pack.expanduser().resolve())
        else:
            install(args.home.expanduser().resolve(), managed)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
