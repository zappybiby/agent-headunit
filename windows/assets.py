"""Resolve upstream files when building a release and verify downloads during setup."""

import hashlib
import json
import lzma
import os
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


FRIDA_ARCH = {"armeabi-v7a": "arm", "arm64-v8a": "arm64", "x86": "x86", "x86_64": "x86_64"}


def github_assets(repo, tag):
    headers = {"Authorization": "Bearer " + os.environ["GH_TOKEN"]} if os.environ.get("GH_TOKEN") else {}
    request = Request(f"https://api.github.com/repos/{repo}/releases/tags/{quote(tag, safe='')}", headers=headers)
    with urlopen(request, timeout=45) as response:
        assets = json.load(response)["assets"]
    return {asset["name"]: asset for asset in assets}


def verified_asset(assets, name):
    item = assets.get(name, {})
    digest = item.get("digest") or ""
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise ValueError(f"No release asset with a SHA-256 digest for {name}.")
    return {"url": item["browser_download_url"], "sha256": digest[7:]}


def resolve_assets(receiver, requirements):
    version = re.search(r"^frida==([\d.]+)$", requirements, flags=re.MULTILINE)
    if not version:
        raise ValueError("Pin the Frida client in backend/requirements.txt before packaging.")
    version = version[1]
    assets = github_assets("frida/frida", version)
    servers = {abi: verified_asset(assets, f"frida-server-{version}-android-{arch}.xz")
               for abi, arch in FRIDA_ARCH.items()}
    apk = verified_asset(github_assets(receiver["repository"], receiver["tag"]), receiver["file"])
    return {"fridaVersion": version, "servers": servers, "receiver": apk}


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
