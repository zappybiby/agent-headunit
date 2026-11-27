from contextlib import nullcontext
import unittest
from unittest.mock import Mock, patch

from accessibility.panels import accessibility_nodes, match_window_roots, render_panels
from projection.alerts import choose_alert, observe_alert
from frida import InvalidOperationError, TransportError

from accessibility.renderer import keep_renderer_sessions, read_windows
from projection.connection import Connection, HeadunitError, SceneChanged, StaleProjectedControl


PERMISSION_OWNER = "com.android.permissioncontroller"
PERMISSION_TITLE = f"{PERMISSION_OWNER}/.permission.ui.GrantPermissionsActivity"
PERMISSION_WINDOW = f"be {PERMISSION_TITLE}"
APP_WINDOW = "aa example.game/.Activity"
PANEL = {"serial": "phone", "id": 21, "owner": "example.game", "activity": "example.game/.Activity",
         "width": 576, "height": 1280, "carBounds": [0, 0, 576, 1280], "screen": {"width": 576, "height": 1280}}
APP = (APP_WINDOW, (21, PANEL["owner"]), 15)
PROMPT = (PERMISSION_WINDOW, (21, PERMISSION_OWNER), 30)


def row(name, bounds, parent=-1, **values):
    return dict({"class": name, "id": "", "bounds": bounds, "parent": parent, "text": "",
                 "description": "", "enabled": True, "editable": False, "focused": False,
                 "focusable": False, "selected": False, "clickable": False, "longClickable": False,
                 "scrollable": False, "actions": 0, "hint": "", "showingHint": False, "password": False}, **values)


class ProjectedAccessibilityTest(unittest.TestCase):
    def test_reuses_the_renderer_until_its_script_or_process_is_replaced(self):
        device = Mock(is_lost=False)
        attachments = [Mock(is_detached=False) for _ in range(3)]
        for attachment in attachments:
            script = attachment.create_script.return_value
            script.is_destroyed = False
            script.exports_sync.snapshot.return_value = [{"display": 21}]
        device.attach.side_effect = attachments
        with (patch("accessibility.renderer.open_device", return_value=nullcontext(device)) as connect,
              patch("accessibility.renderer.java_agent", return_value="agent"), keep_renderer_sessions()):
            self.assertEqual(read_windows("phone", [PANEL], [APP]), [{"display": 21, "pid": 15}])
            read_windows("phone", [PANEL], [APP])
            device.attach.assert_called_once_with(15)
            attachments[0].detach.assert_not_called()
            attachments[0].create_script.return_value.is_destroyed = True
            read_windows("phone", [PANEL], [APP])
            self.assertEqual(read_windows("phone", [PANEL], [(*APP[:2], 17)]), [{"display": 21, "pid": 17}])
            self.assertEqual([entry.args[0] for entry in device.attach.call_args_list], [15, 15, 17])
            connect.assert_called_once()
            attachments[2].detach.assert_not_called()
        for attachment in attachments:
            attachment.detach.assert_called_once_with()

    def test_drops_broken_connections_and_does_not_repeat_dispatched_input(self):
        first, second = Mock(is_lost=False), Mock(is_lost=False)
        for device in (first, second):
            attachment = device.attach.return_value
            attachment.is_detached = False
            attachment.create_script.return_value.is_destroyed = False
        initial = first.attach.return_value.create_script.return_value.exports_sync.snapshot
        initial.side_effect = TransportError("connection lost")
        recovered = second.attach.return_value.create_script.return_value.exports_sync.snapshot
        recovered.side_effect = [[], InvalidOperationError("script has been destroyed"), []]
        target = {"display": 21, "windowKey": APP_WINDOW, "action": "press"}
        with (patch("accessibility.renderer.open_device", side_effect=[nullcontext(first), nullcontext(second)]) as connect,
              patch("accessibility.renderer.java_agent", return_value="agent"), keep_renderer_sessions()):
            with self.assertRaises(SceneChanged):
                read_windows("phone", [PANEL], [APP])
            read_windows("phone", [PANEL], [APP])
            with self.assertRaisesRegex(HeadunitError, "Check the current screen") as error:
                read_windows("phone", [PANEL], [APP], target)
            self.assertIs(type(error.exception), HeadunitError)
            self.assertEqual(recovered.call_count, 2)
            read_windows("phone", [PANEL], [APP])
            self.assertEqual(second.attach.call_count, 2)
            self.assertEqual(connect.call_count, 2)

    def test_virtual_child_keeps_its_bounds_and_ref_between_reader_connections(self):
        panel = {"serial": "phone", "id": 19, "owner": "example.game", "width": 100, "height": 200,
                 "carBounds": [20, 40, 220, 440], "screen": {"width": 240, "height": 480}}
        rows = [row("android.webkit.WebView", [5, 10, 90, 70]),
                row("android.widget.Button", [9, 15, 60, 65], 0, text="Next letter A", clickable=True)]
        first = accessibility_nodes(rows, panel, "ab12 example.game/Game")[1]
        self.assertEqual(first["bounds"], [9, 15, 60, 65])
        self.assertEqual(first["carBounds"], [38, 70, 140, 170])
        self.assertEqual(first["actions"], ["press"])
        rows[1]["identity"] = 711
        second = accessibility_nodes(rows, panel, "ab12 example.game/Game")[1]
        self.assertEqual(first["ref"], second["ref"])
        new_window = accessibility_nodes(rows, panel, "cb45 example.game/Game")[1]
        self.assertNotEqual(first["ref"], new_window["ref"])
        rows[1]["text"] = "Next letter B"
        changed = accessibility_nodes(rows, panel, "ab12 example.game/Game")[1]
        self.assertNotEqual(first["ref"], changed["ref"])

    def test_matches_dialog_and_activity_with_the_same_window_title(self):
        panel = {"serial": "phone", "id": 21, "owner": "example.game", "width": 576, "height": 1280,
                 "carBounds": [0, 0, 576, 1280], "screen": {"width": 576, "height": 1280}}
        title = "example.game/Activity"
        background, dialog = f"aa {title}", f"bb {title}"
        windows = {key: (21, "example.game") for key in (background, dialog)}
        frame = [57, 507, 518, 709]
        geometry = {background: ([0, 0, 576, 1280], "BASE_APPLICATION"), dialog: (frame, "APPLICATION")}
        roots = [{"title": title, "frame": frame, "type": "APPLICATION", "rows": [
            row("android.widget.Button", [110, 550, 400, 600], text="Confirm", clickable=True),
        ]}]
        observed = match_window_roots(roots, panel, windows, geometry)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0]["window"], dialog + " accessibility:0")

    def test_permission_overlay_requires_the_actual_controller_above_the_projected_app(self):
        spoofed = (PERMISSION_WINDOW, (21, "another.app"), 32)
        other_display = (PERMISSION_WINDOW, (0, PERMISSION_OWNER), 30)
        other_activity = (f"90 {PERMISSION_OWNER}/.Settings", (21, PERMISSION_OWNER), 30)
        self.assertEqual(list(render_panels([PANEL], [spoofed, other_display, other_activity, APP, PROMPT])), [PANEL])
        self.assertEqual(list(render_panels([PANEL], [PROMPT, APP])), [
            dict(PANEL, owner=PERMISSION_OWNER, permissionWindow=PERMISSION_WINDOW),
        ])

    def test_permission_observation_and_action_use_the_controller_window(self):
        records = [PROMPT, APP]
        device = Mock()
        capture = device.attach.return_value.create_script.return_value.exports_sync.snapshot
        prompt = {"display": 21, "windowId": 7, "title": PERMISSION_TITLE, "rows": [
            row("android.widget.TextView", [40, 40, 280, 80], text="Allow camera?",
                id=f"{PERMISSION_OWNER}:id/permission_message"),
            row("android.widget.Button", [40, 100, 280, 140], text="While using the app",
                id=f"{PERMISSION_OWNER}:id/permission_allow_foreground_only_button", clickable=True),
        ]}
        different_window = dict(prompt, title="Unrelated window")
        with (patch("accessibility.renderer.managed_device", return_value=nullcontext(device)),
              patch("accessibility.renderer.java_agent", return_value="agent")):
            capture.return_value = [different_window, prompt]
            roots = read_windows("phone", [PANEL], records)
            capture.assert_called_once_with([21], None, False, {"21": PERMISSION_TITLE})
            self.assertEqual(roots, [dict(prompt, pid=30)])
            active, = render_panels([PANEL], records)
            nodes = match_window_roots(roots, active, {key: identity for key, identity, _ in records})
            candidate = observe_alert({"nodes": nodes})["candidate"]
            chosen = choose_alert(candidate, "accept")
            self.assertEqual(candidate["alert"]["source"], "permission")
            self.assertEqual(chosen["ref"], nodes[1]["ref"])
            self.assertNotIn("rendererTarget", nodes[1])
            titles = [dict(prompt["rows"][0], text="Allow microphone?"), prompt["rows"][1]]
            changed = match_window_roots([dict(roots[0], rows=titles)], active,
                                         {key: identity for key, identity, _ in records})
            self.assertNotEqual(changed[1]["ref"], chosen["ref"])

            connection = Connection("phone", None)
            with (patch.object(connection, "snapshot", return_value={"nodes": nodes}), patch("projection.connection.adb") as adb):
                self.assertTrue(connection.request("press", target=chosen["ref"], hit=chosen["ref"])["ok"])
                adb.assert_called_once_with("phone", "shell", "input", "-d", "21", "tap", "160", "120")

            with self.assertRaises(StaleProjectedControl):
                read_windows("phone", [PANEL], records, {"display": 21, "windowKey": APP_WINDOW})
            device.attach.assert_called_once_with(30)
