"""Build both npm packages and the Windows release from a patched Agent Device checkout."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import base64
import shutil
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
from urllib.request import urlopen
from zipfile import ZipFile, ZIP_DEFLATED

from install_provider import pack


PROJECT = Path(__file__).resolve().parents[1]
VERSION = "0.21.43"
COMMIT = "e853b3b17b41f2fe8c299d13bcd9bb2dcb00594b"
INTEGRITY = "DrypBuG5+HnbL9E8sRoeq/QWphQA7u9pBF6L0cE7oxBprORz7ySnYo2RemxPvLLmD2AOwHsZxKv871cITdc83w=="


def verify_android_helpers(archive, version):
    with tarfile.open(archive, "r:gz") as package:
        for helper in ("snapshot-helper", "ime-helper"):
            prefix = f"package/android/{helper}/dist/agent-device-android-{helper}-{version}"
            try:
                with package.extractfile(prefix + ".manifest.json") as metadata:
                    manifest = json.load(metadata)
                with package.extractfile(prefix + ".apk") as apk:
                    digest = hashlib.file_digest(apk, "sha256").hexdigest()
            except KeyError as error:
                raise ValueError(f"The compatibility package is missing the bundled Android {helper}.") from error
            if manifest.get("version") != version or manifest.get("sha256") != digest:
                raise ValueError(f"The bundled Android {helper} does not match agent-device {version}.")


def stage_cdp(checkout, staging, cli, npm, env):
    scripts = checkout / "scripts"
    source_lock = scripts / "headunit-cdp-lock.json"
    lock = json.loads(source_lock.read_text(encoding="utf-8"))
    dependency = lock["packages"][""]["dependencies"]
    vendor = staging / "cdp-dependencies"
    vendor.mkdir()
    shutil.copyfile(source_lock, vendor / "package-lock.json")
    (vendor / "package.json").write_text(json.dumps(lock["packages"][""]), encoding="utf-8")
    subprocess.run([npm, "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--silent"],
                   cwd=vendor, env=env, check=True)
    modules = vendor / "node_modules"
    subprocess.run([sys.executable, "-B", str(scripts / "prepare-headunit-cdp.py"), str(modules / "agent-cdp")],
                   env=env, check=True)
    shutil.move(modules, cli / "node_modules")
    manifest_path = cli / "package.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest.setdefault("dependencies", {}).update(dependency)
    manifest.setdefault("bundleDependencies", []).append("agent-cdp")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return lock


def regular_cdp_file(member):
    return member.type in (tarfile.REGTYPE, tarfile.AREGTYPE) and member.sparse is None


def verify_cdp_contents(package, lock, shim):
    def open_bundled(name):
        try:
            member = package.getmember(f"package/{name}")
        except KeyError as error:
            raise ValueError(f"The compatibility package is missing bundled {name}.") from error
        if not regular_cdp_file(member):
            raise ValueError(f"The bundled CDP member {name} is not a regular file.")
        return package.extractfile(member)

    for name, dependency in lock["packages"].items():
        if not name:
            continue
        with open_bundled(f"{name}/package.json") as file:
            manifest = json.load(file)
        if manifest.get("name") != name.rsplit("node_modules/", 1)[-1] or manifest.get("version") != dependency["version"]:
            raise ValueError(f"The bundled {name} does not match the CDP lock.")
    with open_bundled("node_modules/agent-cdp/LICENSE"):
        pass
    for name in ("bin", "cli", "daemon", "index"):
        with open_bundled(f"node_modules/agent-cdp/dist/{name}.js") as file:
            if b' from "./headunit-ipc.js";' not in file.read():
                raise ValueError(f"The agent-cdp {name} bundle does not use the CDP shim.")
    with open_bundled("node_modules/agent-cdp/dist/headunit-ipc.js") as file:
        if shim is not None and file.read() != shim:
            raise ValueError("The bundled CDP shim differs from the pinned checkout.")


def verify_cdp(archive, lock, *, shim=None):
    with tarfile.open(archive, "r:gz") as package:
        verify_cdp_contents(package, lock, shim)


def package(checkout, output):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
    if commit != COMMIT or json.loads((checkout / "package.json").read_bytes())["version"] != VERSION:
        raise ValueError(f"Build agent-device {VERSION} at {COMMIT} with the headunit patch first.")
    subprocess.run(["git", "apply", "--reverse", "--check", str(PROJECT / "upstream/agent-device.patch")],
                   cwd=checkout, check=True)
    manifest = json.loads((PROJECT / "provider/package.json").read_bytes())
    provider = f"{manifest['name']}-{manifest['version']}.tgz"
    cli = f"agent-device-{VERSION}-headunit-{manifest['version']}.tgz"
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        raise ValueError("Install Node.js with npm before building.")
    output.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output) as temporary:
        stage = Path(temporary)
        archive = stage / "upstream.tgz"
        url = f"https://registry.npmjs.org/agent-device/-/agent-device-{VERSION}.tgz"
        with urlopen(url, timeout=90) as response, archive.open("wb") as target:
            shutil.copyfileobj(response, target)
        with archive.open("rb") as source:
            if hashlib.file_digest(source, "sha512").digest() != base64.b64decode(INTEGRITY):
                raise ValueError("The published Agent Device package failed its integrity check.")
        with tarfile.open(archive) as tar:
            members = (m for m in tar if m.name.startswith("package/") and not m.name.startswith("package/dist/"))
            tar.extractall(stage, members=members, filter="data")
        tree = stage / "package"
        shutil.copytree(checkout / "dist", tree / "dist", dirs_exist_ok=True)
        env = os.environ.copy()
        lock = stage_cdp(checkout, stage, tree, npm, env)
        subprocess.run([npm, "pack", "--ignore-scripts", "--silent", "--pack-destination", str(stage)],
                       cwd=tree, env=env, check=True)
        rebuilt = stage / f"agent-device-{VERSION}.tgz"
        verify_android_helpers(rebuilt, VERSION)
        verify_cdp(rebuilt, lock, shim=(checkout / "scripts/headunit-cdp-ipc.mjs").read_bytes())
        rebuilt.rename(stage / cli)
        pack(stage, env=env)
        bundle = stage / "agent-headunit-windows-x64.zip"
        with ZipFile(bundle, "w", ZIP_DEFLATED) as release:
            for path in (stage / provider, stage / cli, PROJECT / "windows/setup.py",
                         PROJECT / "windows/agent-headunit.cmd", PROJECT / "README.md"):
                release.write(path, path.name)
        for artifact in (stage / provider, stage / cli, bundle):
            artifact.replace(output / artifact.name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    package(args.checkout.resolve(), args.output.resolve())
