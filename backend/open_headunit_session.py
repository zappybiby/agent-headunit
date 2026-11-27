"""Run a command with a private Frida session on a rooted projecting emulator."""

import argparse
from contextlib import contextmanager, nullcontext
import errno
from importlib.util import find_spec
import json
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Event, Thread
import time

from emulators.receiver import receiver_serial
from emulators.pair import check_owner, prepare_pair
from projection.connection import Connection, HeadunitError, adb


def root_transport(phone):
    if adb(phone, "shell", "id", "-u").strip() == "0":
        return "adb-root"
    su = adb(phone, "shell", "command -v su || test ! -x /debug_ramdisk/su || echo /debug_ramdisk/su").strip()
    if not su:
        raise HeadunitError("ADB shell has no root access. Enable adb root or grant shell access in the emulator's root manager.")
    hint = "Enable adb root or grant shell access in the emulator's root manager."
    try:
        uid = adb(phone, "shell", f"{shlex.quote(su)} -c 'id -u'").strip()
    except HeadunitError as error:
        raise HeadunitError(f"Could not verify shell root on {phone}. {hint} {error}") from error
    if uid != "0":
        raise HeadunitError(f"Shell root was denied on {phone}. {hint}")
    return su


def root_command(transport, command):
    return command if transport == "adb-root" else f"{shlex.quote(transport)} -c {shlex.quote(command)}"


def start_server(phone, root, remote, port, token, lifetime, log):
    run = shlex.join([remote, "-l", f"127.0.0.1:{port}", "--token", token])
    # Keep the root shell's input open so it can stop its own server on exit.
    supervise = (f"{run} </dev/null & server=$!; "
                 "trap 'kill \"$server\" 2>/dev/null; wait \"$server\" 2>/dev/null' EXIT; "
                 "trap 'exit 0' HUP INT TERM; read -r stop || :")
    command = root_command(root, f"exec timeout {lifetime} sh -c {shlex.quote(supervise)}")
    return subprocess.Popen(["adb", "-s", phone, "shell", "-T", command], stdin=subprocess.PIPE,
                            stdout=log, stderr=subprocess.STDOUT,
                            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))


def wait_for_server(frida, process, port, token, log_path, closed=None):
    manager = frida.get_device_manager()
    endpoint = f"127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    while process.poll() is None and time.monotonic() < deadline:
        check_owner(closed)
        device = manager.add_remote_device(endpoint, token=token)
        try:
            device.query_system_parameters()
            return
        except (frida.ServerNotRunningError, frida.TransportError, frida.TimedOutError):
            time.sleep(0.25)
        finally:
            manager.remove_remote_device(endpoint)
    reason = log_path.read_text("utf-8", errors="replace").strip().replace(token, "[token]")
    raise HeadunitError("Frida could not start on the phone. " + (reason or "Check the root grant on the emulator."))


def stop_server(process):
    try:
        if process.poll() is None:
            process.stdin.write(b"stop\n")
        process.stdin.close()
    except OSError as error:
        if error.errno not in {errno.EPIPE, errno.EINVAL}:
            raise
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def cleanup_adb(phone, *args):
    try:
        adb(phone, *args)
    except HeadunitError as error:
        if f"device '{phone}' not found" not in str(error):
            print(error, file=sys.stderr)


def require_frida():
    try:
        import frida
    except ImportError as error:
        raise HeadunitError("Install frida and frida-tools in the selected Python environment.") from error
    if find_spec("frida_tools") is None:
        raise HeadunitError("Install frida-tools in the selected Python environment.")
    return frida


@contextmanager
def frida_session(phone, receiver, server, lifetime, directory, closed=None, *, frida=None):
    check_owner(closed)
    if frida is None:
        frida = require_frida()
    if phone == receiver:
        raise HeadunitError("Choose separate phone and receiver serials.")
    if adb(phone, "shell", "getprop", "ro.kernel.qemu").strip() != "1":
        raise HeadunitError("The projecting phone must be an Android emulator.")
    if adb(receiver, "get-state").strip() != "device":
        raise HeadunitError("The Open Headunit receiver is unavailable.")
    receiver_serial(phone, receiver)
    try:
        Connection.connect(phone).snapshot(include_nodes=False)
    except HeadunitError as error:
        raise HeadunitError(f"Connect Open Headunit on {receiver} to Android Auto on {phone} and keep the projection open. {error}") from error
    root = root_transport(phone)
    token = secrets.token_hex(32)
    remote = f"/data/local/tmp/headunit-frida-{secrets.token_hex(8)}"
    device_port = 49152 + secrets.randbelow(16384)
    log_path = directory / "frida.log"
    adb(phone, "push", str(server), remote)
    try:
        adb(phone, "shell", "chmod", "700", remote)
        version = adb(phone, "shell", remote, "--version").strip()
        if version != frida.__version__:
            raise HeadunitError(f"Use a Frida server matching the Python client ({frida.__version__}). Found {version}.")
        port = int(adb(phone, "forward", "tcp:0", f"tcp:{device_port}").strip())
        try:
            with log_path.open("wb") as log:
                process = start_server(phone, root, remote, device_port, token, lifetime, log)
                try:
                    wait_for_server(frida, process, port, token, log_path, closed)
                    session = directory / "session.json"
                    session.write_text(json.dumps({"serial": phone, "port": port, "token": token}), "utf-8")
                    yield session
                finally:
                    stop_server(process)
        finally:
            cleanup_adb(phone, "forward", "--remove", f"tcp:{port}")
    finally:
        cleanup_adb(phone, "shell", "rm", "-f", remote)


def stop_daemon(env, state):
    executable = shutil.which("agent-device")
    if executable and (state / "daemon.json").is_file():
        result = subprocess.run([executable, "daemon", "stop"], env=env, capture_output=True, timeout=20)
        if result.returncode:
            detail = (result.stderr or result.stdout).decode("utf-8", "replace").strip()
            print(detail or "Could not stop the Open Headunit agent-device daemon.", file=sys.stderr)


@contextmanager
def touch_session(phone):
    helper = Path(__file__).with_name("android") / "projected-touch.jar"
    if not helper.is_file() or adb(phone, "shell", "getprop", "ro.build.version.sdk").strip() not in {"36", "37"}:
        yield None
        return
    try:
        root = root_transport(phone)
    except HeadunitError:
        yield None
        return
    remote = f"/data/local/tmp/headunit-touch-{secrets.token_hex(8)}.jar"
    adb(phone, "push", str(helper), remote)
    try:
        yield {"jar": remote, "root": root}
    finally:
        cleanup_adb(phone, "shell", "rm", "-f", remote)


def watch_owner(closed, adopted, ready):
    try:
        pipe = sys.stdin.fileno()
        if os.read(pipe, 1) == b"+" and ready.is_set():
            adopted.set()
            os.read(pipe, 1)
    finally:
        closed.set()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--phone", help="ADB serial of the rooted projecting emulator")
    p.add_argument("--receiver", help="ADB serial of the Open Headunit receiver")
    p.add_argument("--phone-avd", help="start this prepared rooted phone AVD by name")
    p.add_argument("--receiver-avd", help="start this prepared Open Headunit receiver AVD by name")
    p.add_argument("--with-audio", action="store_true", help="enable host audio on a newly started receiver AVD")
    p.add_argument("--frida-server", type=Path, required=True, help="matching uncompressed Android Frida server")
    p.add_argument("--lifetime", type=int, default=2700, help="maximum server lifetime in seconds (default 2700)")
    p.add_argument("--managed-service", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("command", nargs=argparse.REMAINDER, help="command to run, following --")
    args = p.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not args.frida_server.is_file():
        p.error(f"No Frida server file was found at {args.frida_server}.")
    if args.lifetime < 1:
        p.error("Set the Frida server lifetime to at least one second.")
    if bool(command) == args.managed_service:
        p.error("Choose --managed-service or provide a command after --.")
    adopted = Event()
    closed = Event() if args.managed_service else None
    if args.phone_avd and args.receiver_avd and not (args.phone or args.receiver):
        pair = prepare_pair(args.phone_avd, args.receiver_avd, adopted=adopted, audio=args.with_audio, closed=closed)
    elif args.phone and args.receiver and not (args.phone_avd or args.receiver_avd or args.with_audio):
        pair = nullcontext((args.phone, args.receiver))
    else:
        p.error("Supply either --phone and --receiver serials or --phone-avd and --receiver-avd names.")
    try:
        frida = require_frida()
        if closed is not None:
            ready = Event()
            Thread(target=watch_owner, args=(closed, adopted, ready), daemon=True).start()
        with pair as (phone, receiver), TemporaryDirectory(prefix="headunit-agent-") as tmp:
            directory = Path(tmp)
            with (frida_session(phone, receiver, args.frida_server.resolve(), args.lifetime,
                                directory, closed, frida=frida) as session,
                  touch_session(phone) as touch):
                if closed is not None:
                    if closed.is_set():
                        return 0
                    ready.set()
                    print(json.dumps({"phone": phone, "receiver": receiver, "fridaSession": str(session),
                                      "touch": touch}), flush=True)
                    closed.wait()
                    return 0
                state = directory / "daemon"
                env = dict(os.environ, ANDROID_SERIAL=phone, HEADUNIT_RECEIVER_SERIAL=receiver,
                           HEADUNIT_FRIDA_SESSION=str(session), HEADUNIT_PYTHON=sys.executable,
                           AGENT_DEVICE_STATE_DIR=str(state))
                env.pop("HEADUNIT_TOUCH_DEVICE_JAR", None)
                env.pop("HEADUNIT_TOUCH_ROOT", None)
                if touch:
                    env.update(HEADUNIT_TOUCH_DEVICE_JAR=touch["jar"], HEADUNIT_TOUCH_ROOT=touch["root"])
                executable = shutil.which(command[0])
                if executable:
                    command[0] = executable
                adopted.set()
                try:
                    return subprocess.call(command, env=env)
                finally:
                    stop_daemon(env, state)
    except KeyboardInterrupt:
        return 130
    except (HeadunitError, OSError, ValueError, subprocess.SubprocessError) as error:
        p.exit(1, str(error) + "\n")


if __name__ == "__main__":
    sys.exit(main())
