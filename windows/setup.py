"""Install the Windows release next to this script."""

import argparse
import hashlib
import lzma
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.request import urlopen
import venv


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".runtime"
FRIDA = "https://github.com/frida/frida/releases/download/17.27.6/frida-server-17.27.6-android-x86_64.xz"
RECEIVER = ("https://github.com/andreknieriem/open-headunit/releases/download/"
            "v.4.1.0-beta1/com.andrerinas.headunitrevived_4.1.0-beta1.apk")


def download(url, destination, digest):
    if destination.is_file():
        with destination.open("rb") as existing:
            if hashlib.file_digest(existing, "sha256").hexdigest() == digest:
                return
    print(f"Downloading {destination.name}", flush=True)
    with TemporaryDirectory(dir=destination.parent) as tmp:
        staged = Path(tmp) / destination.name
        with urlopen(url, timeout=90) as source, staged.open("wb") as target:
            shutil.copyfileobj(source, target)
        with staged.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != digest:
                raise ValueError(f"SHA-256 mismatch for {destination.name}.")
        staged.replace(destination)


def install(phone, receiver):
    npm = shutil.which("npm.cmd")
    if os.name != "nt" or not npm:
        raise ValueError("Install Node.js on Windows and reopen PowerShell.")
    packages = []
    for pattern in ("agent-headunit-*.tgz", "agent-device-*-headunit-*.tgz"):
        matches = list(ROOT.glob(pattern))
        if len(matches) != 1:
            raise ValueError("Extract the complete release ZIP into its own folder before running setup.")
        packages.extend(matches)
    RUNTIME.mkdir(exist_ok=True)
    subprocess.run([npm, "install", "--prefix", str(RUNTIME), "--ignore-scripts", "--no-audit",
                    "--no-fund", "--save-exact", *map(str, packages)], check=True, cwd=ROOT)
    provider = RUNTIME / "node_modules/agent-headunit"
    venv.EnvBuilder(with_pip=True).create(RUNTIME / "python")
    python = RUNTIME / "python/Scripts/python.exe"
    subprocess.run([python, "-m", "pip", "install", "-r", provider / "backend/requirements.txt"], check=True)
    archive = RUNTIME / "frida-server.xz"
    download(FRIDA, archive, "5d3030f90fc110fc91249c392e1f1402522f89753a6404e83884fdaa31a04bf0")
    binary = RUNTIME / "frida-server"
    with TemporaryDirectory(dir=RUNTIME) as tmp:
        staged = Path(tmp) / binary.name
        with lzma.open(archive) as source, staged.open("wb") as target:
            shutil.copyfileobj(source, target)
        staged.replace(binary)
    download(RECEIVER, ROOT / "open-headunit.apk", "3ce6e2c798685df7eeeb5ae4ba93655e646f64b12b2747c0053ba5dd1a7a12aa")
    subprocess.run([python, "-B", provider / "install_provider.py", RUNTIME / "home",
                    "--phone-avd", phone, "--receiver-avd", receiver, "--frida-server", binary], check=True)
    print(f"Configured {phone} and {receiver}. Install open-headunit.apk on {receiver}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phone-avd", default="AA_Phone")
    parser.add_argument("--receiver-avd", default="AA_Receiver")
    args = parser.parse_args()
    try:
        install(args.phone_avd, args.receiver_avd)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
