"""Resolve upstream files when building a release and verify downloads during setup."""

import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


FRIDA_ARCH = {"armeabi-v7a": "arm", "arm64-v8a": "arm64", "x86": "x86", "x86_64": "x86_64"}


def github_assets(repo, tag=None):
    headers = {"Authorization": "Bearer " + os.environ["GH_TOKEN"]} if os.environ.get("GH_TOKEN") else {}
    release = "tags/" + quote(tag, safe="") if tag else "latest"
    request = Request(f"https://api.github.com/repos/{repo}/releases/{release}", headers=headers)
    with urlopen(request, timeout=45) as response:
        assets = json.load(response)["assets"]
    return {asset["name"]: asset for asset in assets}


def verified_asset(assets, name):
    item = assets.get(name, {})
    digest = item.get("digest") or ""
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError(f"No release asset with a SHA-256 digest for {name}.")
    return {"url": item["browser_download_url"], "sha256": digest[7:]}


def resolve_release(receiver, requirements):
    with TemporaryDirectory() as tmp:
        report = Path(tmp) / "pip.json"
        subprocess.run([sys.executable, "-m", "pip", "install", "--dry-run", "--ignore-installed",
                        "--quiet", "--report", report, "-r", requirements], check=True)
        packages = json.loads(report.read_text("utf-8"))["install"]
    versions = {item["metadata"]["name"].lower(): item["metadata"]["version"]
                for item in packages if item["requested"]}
    version = versions["frida"]
    assets = github_assets("frida/frida", version)
    servers = {abi: verified_asset(assets, f"frida-server-{version}-android-{arch}.xz")
               for abi, arch in FRIDA_ARCH.items()}
    apks = github_assets(receiver["repository"])
    distribution = re.compile(re.escape(receiver["package"]) + r"_[0-9][0-9A-Za-z.-]*\.apk")
    names = [name for name in apks if distribution.fullmatch(name) and not re.search(r"(?i)(debug|unsigned)", name)]
    if len(names) != 1:
        raise ValueError(f"Expected one release APK for {receiver['package']}, found {names}.")
    lock = {"fridaVersion": version, "servers": servers, "receiver": verified_asset(apks, names[0])}
    pins = "".join(f"{name}=={value}\n" for name, value in sorted(versions.items()))
    return pins, lock


def release_file(cache, asset):
    digest = asset["sha256"]
    name = Path(urlsplit(asset["url"]).path).name
    directory = cache / digest
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / name
    if destination.is_file():
        with destination.open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() == digest:
                return destination
    print(f"Downloading {name}", flush=True)
    with TemporaryDirectory(dir=directory) as tmp:
        staged = Path(tmp) / name
        with urlopen(asset["url"], timeout=90) as source, staged.open("wb") as output:
            shutil.copyfileobj(source, output)
        with staged.open("rb") as f:
            if hashlib.file_digest(f, "sha256").hexdigest() != digest:
                raise ValueError(f"SHA-256 mismatch for {name}.")
        staged.replace(destination)
    return destination


def frida_server(cache, asset):
    archive = release_file(cache, asset)
    binary = archive.with_suffix("")
    with TemporaryDirectory(dir=archive.parent) as tmp:
        staged = Path(tmp) / binary.name
        with lzma.open(archive) as source, staged.open("wb") as output:
            shutil.copyfileobj(source, output)
        staged.replace(binary)
    return binary
