"""Build the projected touch helper for distribution."""

import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory


MIN_API = 36
JAVA_VERSION = 21


def latest_sdk_file(directory, filename, *, prefix="", min_major=0):
    candidates = []
    if directory.is_dir():
        for entry in directory.iterdir():
            if not entry.name.startswith(prefix):
                continue
            version = entry.name[len(prefix):]
            if not re.fullmatch(r"\d+(?:\.\d+)*", version):
                continue
            parts = tuple(map(int, version.split(".")))
            file = entry / filename
            if parts[0] >= min_major and file.is_file():
                candidates.append((parts, file))
    return max(candidates, default=((), None))[1]


def android_sdk_files():
    location = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")
    if not location:
        raise FileNotFoundError("Set ANDROID_SDK_ROOT or ANDROID_HOME to the Android SDK.")
    sdk = Path(location).expanduser().resolve()
    platform = latest_sdk_file(sdk / "platforms", "android.jar", prefix="android-", min_major=MIN_API)
    if platform is None:
        raise FileNotFoundError(f"Install Android SDK Platform {MIN_API} or newer in {sdk}.")
    d8 = latest_sdk_file(sdk / "build-tools", "lib/d8.jar")
    if d8 is None:
        raise FileNotFoundError(f"Install Android SDK Build Tools with D8 in {sdk}.")
    return platform, d8


def run_tool(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
    if result.returncode:
        output = result.stdout.strip()
        raise OSError(f"{Path(args[0]).name} failed with exit code {result.returncode}: {output}")
    return result.stdout


def java_tools():
    executable = ".exe" if os.name == "nt" else ""
    home = os.environ.get("JAVA_HOME")
    compiler = Path(home).expanduser() / "bin" / ("javac" + executable) if home else shutil.which("javac" + executable)
    if not compiler:
        raise FileNotFoundError(f"Install JDK {JAVA_VERSION} and set JAVA_HOME to it.")
    javac = Path(compiler).resolve()
    java = javac.with_name("java" + executable)
    if not javac.is_file() or not java.is_file():
        raise FileNotFoundError(f"JDK {JAVA_VERSION} must contain java and javac in {javac.parent}.")
    version = run_tool([javac, "-version"]).strip()
    if not re.search(rf"(?m)^javac {JAVA_VERSION}(?:\D|$)", version):
        raise OSError(f"The projected touch helper requires JDK {JAVA_VERSION}. Found {version} at {javac}.")
    return java, javac


def build_touch_helper(source: Path) -> bytes:
    source = source.resolve(strict=True)
    platform, d8 = android_sdk_files()
    java, javac = java_tools()
    with TemporaryDirectory(prefix="headunit-touch-") as temporary:
        work = Path(temporary)
        classes = work / "classes"
        classes.mkdir()
        run_tool([javac, "--release", str(JAVA_VERSION), "-encoding", "UTF-8", "-classpath", platform,
                  "-d", classes, source])
        jar = work / "projected-touch.jar"
        run_tool([java, "-cp", d8, "com.android.tools.r8.D8", "--lib", platform,
                  "--min-api", str(MIN_API), "--output", jar, *sorted(classes.rglob("*.class"))])
        return jar.read_bytes()
