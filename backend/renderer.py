"""Read Android accessibility nodes inside a live projected window with Frida."""

from contextlib import ExitStack, contextmanager, suppress
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
from functools import cache
from importlib.resources import files
import json
import os
from pathlib import Path

from accessibility import render_panels
from transport import HeadunitError, SceneChanged, StaleProjectedControl

_renderer_sessions = ContextVar("renderer_sessions", default=None)


@contextmanager
def open_device(serial, frida):
    config_path = os.environ.get("HEADUNIT_FRIDA_SESSION")
    if not config_path:
        raise ValueError("Select an authorized Frida session with HEADUNIT_FRIDA_SESSION.")
    session = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
    if session["serial"] != serial:
        raise ValueError("The Frida session belongs to another phone.")
    port = session["port"]
    if type(port) is not int or not 0 < port < 65536:
        raise ValueError("Invalid local Frida port.")
    manager = frida.get_device_manager()
    endpoint = f"127.0.0.1:{port}"
    device = manager.add_remote_device(endpoint, token=session["token"])
    try:
        yield device
    finally:
        manager.remove_remote_device(endpoint)


def detach(attachment):
    import frida

    with suppress(frida.InvalidOperationError, frida.TransportError, frida.TimedOutError):
        attachment.detach()


def load_projected_script(device, pid):
    attachment = device.attach(pid)
    try:
        script = attachment.create_script(java_agent("projected-tree"), name="projected-tree")
        script.load()
        return attachment, script
    except BaseException:
        detach(attachment)
        raise


class RendererSessions:
    def __init__(self):
        self.connection = ExitStack()
        self.device = None
        self.serial = None
        self.scripts = {}

    def connect(self, serial, frida):
        if self.device is not None:
            if self.serial != serial:
                raise ValueError("The Frida session belongs to another phone.")
            if self.device.is_lost:
                self.close(frida)
        if self.device is None:
            self.device = self.connection.enter_context(open_device(serial, frida))
            self.serial = serial
        return self.device

    def script(self, device, pid):
        entry = self.scripts.get(pid)
        if entry is None or entry[0].is_detached or entry[1].is_destroyed:
            self.discard(pid)
            entry = self.scripts[pid] = load_projected_script(device, pid)
        return entry[1]

    def discard(self, pid):
        entry = self.scripts.pop(pid, None)
        if entry is not None:
            detach(entry[0])

    def close(self, frida):
        try:
            for pid in list(self.scripts):
                self.discard(pid)
        finally:
            self.device = self.serial = None
            with suppress(frida.InvalidArgumentError, frida.InvalidOperationError, frida.TransportError, frida.TimedOutError,
                          frida.ServerNotRunningError):
                self.connection.close()


@contextmanager
def keep_renderer_sessions():
    sessions = RendererSessions()
    token = _renderer_sessions.set(sessions)
    try:
        yield
    finally:
        _renderer_sessions.reset(token)
        if sessions.device is not None:
            import frida
            sessions.close(frida)


@contextmanager
def managed_device(serial):
    import frida

    sessions = _renderer_sessions.get()
    disconnected = (frida.TransportError, frida.ServerNotRunningError)
    try:
        if sessions is None:
            with open_device(serial, frida) as device:
                yield device
        else:
            yield sessions.connect(serial, frida)
    except HeadunitError as error:
        if sessions is not None and isinstance(error.__cause__, disconnected):
            sessions.close(frida)
        raise
    except (frida.RPCException, frida.InvalidOperationError, frida.PermissionDeniedError, frida.ProcessNotFoundError,
            frida.TransportError, frida.ServerNotRunningError, frida.TimedOutError, frida.NotSupportedError) as error:
        if sessions is not None and isinstance(error, disconnected):
            sessions.close(frida)
        raise ValueError(str(error).splitlines()[0]) from error


@cache
def java_agent(name):
    bridge = files("frida_tools").joinpath("bridges", "java.js").read_text(encoding="utf-8")
    probe = Path(__file__).with_name("frida").joinpath(name + ".js").read_text(encoding="utf-8")
    return "const Java = (() => {" + bridge + "\nreturn bridge;})();\n" + probe


def read_windows(serial, panels, records, target=None, *, include_screen_reader=False):
    import frida

    processes = {}
    permission_titles = {}
    for panel in render_panels(panels, records):
        if target and panel["id"] != target["display"]:
            continue
        permission_window = panel.get("permissionWindow")
        matches = [(key, pid) for key, identity, pid in records if identity == (panel["id"], panel["owner"])
                   and (not permission_window or key == permission_window)]
        if permission_window:
            permission_titles[panel["id"]] = permission_window.partition(" ")[2]
        if target:
            matches = [(key, pid) for key, pid in matches if key == target["windowKey"]]
            if not matches or permission_window:
                raise StaleProjectedControl("The projected window changed. Capture a new snapshot.")
        pids = {pid for _, pid in matches}
        if not pids or None in pids:
            raise ValueError(f"Android did not report the owning process for display {panel['id']}.")
        for pid in pids:
            processes.setdefault(pid, set()).add(panel["id"])
    if target and len(processes) != 1:
        raise ValueError("The projected control no longer has a unique owner.")
    sessions = _renderer_sessions.get()
    with managed_device(serial) as device:
        if sessions is not None and target is None:
            for pid in sessions.scripts.keys() - processes.keys():
                sessions.discard(pid)

        def capture(item):
            pid, displays = item
            attachment = None
            try:
                try:
                    if sessions is None:
                        attachment, script = load_projected_script(device, pid)
                    else:
                        script = sessions.script(device, pid)
                except (frida.InvalidOperationError, frida.ProcessNotFoundError) as error:
                    if target:
                        raise StaleProjectedControl(
                            "The projected window changed before input. Capture a new snapshot."
                        ) from error
                    raise SceneChanged("The projected window changed while reading. Retry the snapshot.") from error
                titles = {str(d): permission_titles[d] for d in displays if d in permission_titles}
                try:
                    return script.exports_sync.snapshot(sorted(displays), target, include_screen_reader, titles)
                except (frida.InvalidOperationError, frida.TransportError, frida.TimedOutError) as error:
                    if sessions is not None:
                        sessions.discard(pid)
                    if target:
                        raise HeadunitError(
                            "Lost the projected window during input. Check the current screen before retrying."
                        ) from error
                    raise SceneChanged("The projected window changed while reading. Retry the snapshot.") from error
            finally:
                if attachment is not None:
                    detach(attachment)

        if target:
            result = capture(next(iter(processes.items())))
            if result == {"status": "guard-changed"}:
                raise StaleProjectedControl("The control changed. Capture a new snapshot.")
            if result is not True:
                raise ValueError("Android did not perform the requested accessibility action.")
            return True
        items = list(processes.items())
        if len(items) < 2:
            results = list(map(capture, items))
        else:
            with ThreadPoolExecutor(max_workers=min(4, len(items))) as workers:
                results = list(workers.map(capture, items))
        return [dict(window, pid=pid) for (pid, _), windows in zip(items, results) for window in windows
                if window["display"] not in permission_titles or window["title"] == permission_titles[window["display"]]]
