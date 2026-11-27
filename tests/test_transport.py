from io import BytesIO
import unittest
from unittest.mock import call, patch
from zipfile import ZipFile

from agent_rpc import guard_touch_ref, run
from transport import Connection, HeadunitError, NoVisibleProjection, SceneChanged, collect_nodes, projected_field, window_records


class UnavailableProjectionTreeTest(unittest.TestCase):
    panel = {"id": 128, "name": "Game", "owner": "example.game", "screen": {"width": 864, "height": 1920}, "z": 0}

    def test_capture_reads_a_fresh_layout_after_a_renderer_change_and_missing_panel(self):
        with (patch("transport.panels_on", side_effect=[[], [self.panel], [self.panel]]) as layouts,
              patch.dict("transport.os.environ", {"HEADUNIT_FRIDA_SESSION": "test"}),
              patch("transport.adb", return_value="window dump"), patch("transport.window_details", return_value=[]),
              patch("transport.match_window_roots", return_value=[]), patch("transport.time.sleep"),
              patch("renderer.read_windows", side_effect=[SceneChanged("exited"), []])):
            result = Connection("phone", None).snapshot()
        self.assertEqual(result["displays"], [self.panel])
        self.assertEqual(layouts.call_count, 3)

    def test_missing_projection_surfaces_a_reconnect_message_after_bounded_reads(self):
        with (patch("transport.panels_on", return_value=[]) as layouts, patch("transport.time.sleep"),
              self.assertRaisesRegex(NoVisibleProjection, "Check the Open Headunit connection")):
            Connection("phone", None).snapshot()
        self.assertEqual(layouts.call_count, 3)

    def test_session_and_hardware_keys_only_need_the_projection_layout(self):
        with patch("transport.panels_on", return_value=[self.panel]), patch("transport.adb") as adb, \
                patch("agent_rpc.car_key") as key, patch("agent_rpc.receiver_serial", return_value="receiver"), \
                patch("agent_rpc.adb", return_value="1\n") as props:
            layout = run({"op": "layout", "serial": "phone"})
            self.assertEqual(layout["displays"], [self.panel])
            self.assertTrue(layout["emulators"])
            self.assertEqual(props.call_args_list, [call(serial, "shell", "getprop", "ro.kernel.qemu")
                                                    for serial in ("phone", "receiver")])
            self.assertEqual(run({"op": "close", "serial": "phone", "target": "Android Auto"}), {"ok": True})
            run({"op": "home", "serial": "phone"})
            run({"op": "back", "serial": "phone"})
            for keycode in (85, 87, 88):
                run({"op": "mediaKey", "serial": "phone", "keycode": keycode})
            self.assertEqual(key.call_args_list, [call("phone", k) for k in (3, 4, 85, 87, 88)])
            adb.assert_not_called()

    def test_empty_window_is_reported_on_the_correct_display(self):
        archive = BytesIO()
        with ZipFile(archive, "w") as windows:
            windows.writestr("a0 Game", b"")
        with self.assertRaisesRegex(SceneChanged, "empty view hierarchy for Game on display 128"):
            collect_nodes([self.panel], {"a0 Game": (128, "example.game")}, archive.getvalue())

    def test_selects_renderer_pid_from_the_visible_window(self):
        state = ("  Window #0 Window{af u0 Navigation}:\n"
                 "    mDisplayId=17 mSession=Session{acd 441:uid42}\n"
                 "    mOwnerUid=10042 showForAllUsers=false package=org.example.nav\n"
                 "    isVisible=true\n")
        self.assertEqual(list(window_records(state)), [("af Navigation", (17, "org.example.nav"), 441)])
        self.assertFalse(list(window_records(state.replace("isVisible=true", "isVisible=false"))))

    def test_virtual_keyboard_targets_only_its_unique_visible_editor(self):
        field = dict(display=17, fieldId="a", focused=False, enabled=True)
        other = dict(display=18, fieldId="b", focused=True, enabled=True)
        tree = dict(keyboardVisible=True, displays=[dict(id=17, receivesKeyboard=True), dict(id=18)],
                    nodes=[field, other])
        self.assertIs(projected_field(tree), field)
        tree["nodes"].append(dict(field, fieldId="c"))
        self.assertIsNone(projected_field(tree))
        tree["keyboardVisible"] = False
        self.assertIs(projected_field(tree), other)

    def test_focused_editor_wins_when_keyboard_history_still_names_the_launcher(self):
        field = dict(display=14, fieldId="maps", focused=True, enabled=True)
        tree = dict(keyboardVisible=True, displays=[dict(id=14), dict(id=16, receivesKeyboard=True)], nodes=[field])
        self.assertIs(projected_field(tree), field)
        tree["nodes"].append(dict(field, display=15, fieldId="popup"))
        self.assertIsNone(projected_field(tree))

    def test_editor_touch_keeps_the_same_visible_field_across_a_ref_change(self):
        panel = {"id": 17}
        field = {"display": 17, "ref": "changed", "fieldId": "editor", "enabled": True, "editable": True,
                 "actions": ["press"], "pressRegions": [[0, 0, 100, 100]]}
        tree = {"nodes": [field]}
        guard_touch_ref(tree, "original", panel, 20, 20, "editor")
        with self.assertRaisesRegex(HeadunitError, "no longer occupies"):
            guard_touch_ref(tree, "original", panel, 110, 20, "editor")
        with self.assertRaisesRegex(HeadunitError, "Another projected window"):
            guard_touch_ref(tree, "original", {"id": 18}, 20, 20, "editor")
        with self.assertRaisesRegex(HeadunitError, "moved or disappeared"):
            guard_touch_ref(tree, "original", panel, 20, 20, "different-editor")
        tree["nodes"].append(dict(field, ref="duplicate"))
        with self.assertRaisesRegex(HeadunitError, "moved or disappeared"):
            guard_touch_ref(tree, "original", panel, 20, 20, "editor")

    def test_named_touch_checks_the_current_native_control_and_its_point(self):
        panel = {"id": 17}
        button = {"display": 17, "ref": "after-redraw", "pressId": "same-control", "enabled": True,
                  "actions": ["press"], "pressRegions": [[0, 0, 100, 100]]}
        tree = {"nodes": [button]}
        guard_touch_ref(tree, "before-redraw", panel, 20, 20, press_id="same-control")
        with self.assertRaisesRegex(HeadunitError, "no longer occupies"):
            guard_touch_ref(tree, "before-redraw", panel, 101, 20, press_id="same-control")
        tree["nodes"].append(dict(button, ref="overlay", pressId="overlay"))
        with self.assertRaisesRegex(HeadunitError, "Another projected control"):
            guard_touch_ref(tree, "before-redraw", panel, 20, 20, press_id="same-control")
        tree["nodes"] = [dict(button, pressId="rebound")]
        with self.assertRaisesRegex(HeadunitError, "moved or disappeared"):
            guard_touch_ref(tree, "after-redraw", panel, 20, 20, press_id="same-control")
