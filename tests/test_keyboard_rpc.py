import unittest
from unittest.mock import call, patch

from agent_rpc import GEARHEAD_TOOLTIP, KEYBOARD_CLOSE, KEYBOARD_SEARCH, run
from projection import GEARHEAD, TOUCH_IME
from transport import HeadunitError


MAPS = "com.google.android.apps.maps"
PHONE = "emulator-5554"


def scene(*, visible=True):
    screen = {"width": 100, "height": 100}
    editor = {"id": 3, "owner": MAPS, "serial": PHONE, "receivesKeyboard": visible, "z": 0,
              "screen": screen, "carBounds": [0, 0, 100, 100], "width": 100, "height": 100,
              "hitRegions": [[0, 0, 100, 100]]}
    keyboard = {"id": 8, "owner": GEARHEAD, "serial": PHONE, "carWindow": TOUCH_IME, "z": 1,
                "screen": screen, "carBounds": [0, 60, 100, 100], "width": 100, "height": 40,
                "hitRegions": [[0, 0, 100, 40]]}
    field = {"display": 3, "packageName": MAPS, "id": MAPS + ":id/search", "fieldId": "editor", "ref": "field",
             "rendererTarget": {"display": 3, "windowId": 12, "guard": "fresh"},
             "enabled": True, "focused": True}
    close = {"display": 8, "packageName": GEARHEAD, "id": KEYBOARD_CLOSE, "ref": "close", "enabled": True,
             "actions": [], "bounds": [0, 25, 20, 39], "carBounds": [0, 85, 20, 99]}
    search = dict(close, id=KEYBOARD_SEARCH, ref="return", bounds=[80, 25, 100, 39], carBounds=[80, 85, 100, 99])
    return {"serial": PHONE, "keyboardVisible": visible, "displays": [editor, keyboard] if visible else [editor],
            "nodes": [field, close, search] if visible else [field]}


def occluded_scene(*, panel_name=GEARHEAD_TOOLTIP, cover_return=False):
    tree = scene()
    keyboard = tree["displays"][-1]
    key = tree["nodes"][-1 if cover_return else -2]
    key.update(pressRegions=[], rendererTarget={"display": 8, "windowId": 12, "guard": "key"})
    tooltip_left, tooltip_right = (40, 100) if cover_return else (0, 60)
    remaining = [0, 15, 40, 40] if cover_return else [60, 15, 100, 40]
    keyboard["hitRegions"] = [[0, 0, 100, 15], remaining]
    tree["displays"].append(dict(keyboard, id=15, carWindow=panel_name, z=2,
                                 carBounds=[tooltip_left, 75, tooltip_right, 100], width=60, height=25,
                                 hitRegions=[[0, 0, 60, 25]]))
    return tree


class KeyboardRpcTest(unittest.TestCase):
    @patch("headunit.Headunit")
    def test_status_uses_the_projected_keyboard_and_focus(self, headunit):
        tree = scene()
        tree["nodes"][-1]["description"] = " Search "
        headunit.return_value.connection.snapshot.return_value = tree

        self.assertEqual(run({"op": "keyboardStatus", "serial": PHONE}), {
            "ok": True, "kind": "ime-probe", "visible": True, "inputMethodPackage": GEARHEAD,
            "inputOwner": "app", "returnKey": "search", "returnKeyLabel": "Search",
            "focusedPackage": MAPS, "focusedResourceId": MAPS + ":id/search",
        })

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_dismiss_presses_the_close_key_and_checks_that_the_keyboard_hides(self, headunit, adb):
        connection = headunit.return_value.connection
        connection.snapshot.side_effect = [scene(), scene(), scene(visible=False)]

        self.assertEqual(run({"op": "keyboardDismiss", "serial": PHONE}), {
            "ok": True, "kind": "ime-probe", "visible": False, "wasVisible": True, "dismissed": True, "attempts": 1,
        })
        adb.assert_called_once_with(PHONE, "shell", "input", "-d", "8", "tap", "10", "32")
        self.assertEqual(connection.snapshot.call_args_list, [call(include_nodes=False), call(), call(include_nodes=False)])

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_dismiss_hidden_keyboard_does_not_touch_the_app(self, headunit, adb):
        headunit.return_value.connection.snapshot.return_value = scene(visible=False)

        self.assertEqual(run({"op": "keyboardDismiss"}), {
            "ok": True, "kind": "ime-probe", "visible": False, "wasVisible": False, "dismissed": False, "attempts": 0,
        })
        adb.assert_not_called()

    @patch("agent_rpc.time.monotonic", side_effect=[0, 3])
    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_dismiss_fails_when_the_keyboard_stays_open(self, headunit, adb, _):
        headunit.return_value.connection.snapshot.return_value = scene()

        with self.assertRaisesRegex(HeadunitError, "remained visible"):
            run({"op": "keyboardDismiss"})
        adb.assert_called_once()

    @patch("renderer.read_windows")
    @patch("agent_rpc.adb", return_value="")
    @patch("headunit.Headunit")
    def test_dismiss_uses_the_native_close_action_under_the_gearhead_tooltip(self, headunit, adb, read_windows):
        tree = occluded_scene()
        headunit.return_value.connection.snapshot.side_effect = [tree, tree, scene(visible=False)]

        self.assertTrue(run({"op": "keyboardDismiss"})["dismissed"])
        adb.assert_called_once_with(PHONE, "shell", "dumpsys", "window", "windows")
        read_windows.assert_called_once_with(PHONE, tree["displays"], [],
                                             {"display": 8, "windowId": 12, "guard": "key", "action": "press"})

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_dismiss_does_not_act_through_another_covering_panel(self, headunit, adb):
        headunit.return_value.connection.snapshot.return_value = occluded_scene(panel_name=GEARHEAD + ":Alert")

        with self.assertRaisesRegex(HeadunitError, "covers that control"):
            run({"op": "keyboardDismiss"})
        adb.assert_not_called()

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_enter_does_not_act_through_the_gearhead_tooltip(self, headunit, adb):
        headunit.return_value.connection.snapshot.return_value = occluded_scene(cover_return=True)

        with self.assertRaisesRegex(HeadunitError, "covers that control"):
            run({"op": "keyboardEnter"})
        adb.assert_not_called()

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_enter_presses_search_on_the_keyboard_display(self, headunit, adb):
        headunit.return_value.connection.snapshot.return_value = scene()

        self.assertEqual(run({"op": "keyboardEnter"}), {"ok": True, "kind": "android-acknowledged"})
        adb.assert_called_once_with(PHONE, "shell", "input", "-d", "8", "tap", "90", "32")

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_enter_refuses_a_resource_id_from_another_panel(self, headunit, adb):
        tree = scene()
        tree["nodes"][-1]["display"] = 3
        headunit.return_value.connection.snapshot.return_value = tree

        with self.assertRaisesRegex(HeadunitError, "no available Return key"):
            run({"op": "keyboardEnter"})
        adb.assert_not_called()

    @patch("renderer.read_windows")
    @patch("agent_rpc.adb", return_value="")
    @patch("headunit.Headunit")
    def test_enter_with_keyboard_hidden_targets_the_focused_native_editor(self, headunit, adb, read_windows):
        tree = scene(visible=False)
        headunit.return_value.connection.snapshot.return_value = tree

        self.assertEqual(run({"op": "keyboardEnter"}), {"ok": True, "kind": "android-acknowledged"})
        adb.assert_called_once_with(PHONE, "shell", "dumpsys", "window", "windows")
        read_windows.assert_called_once_with(PHONE, tree["displays"], [],
                                             {"display": 3, "windowId": 12, "guard": "fresh", "action": "imeEnter"})

    @patch("agent_rpc.adb")
    @patch("headunit.Headunit")
    def test_enter_without_a_focused_editor_refuses_before_dispatch(self, headunit, adb):
        tree = scene(visible=False)
        tree["nodes"][0]["focused"] = False
        headunit.return_value.connection.snapshot.return_value = tree

        with self.assertRaisesRegex(HeadunitError, "Focus the projected text field"):
            run({"op": "keyboardEnter"})
        adb.assert_not_called()


if __name__ == "__main__":
    unittest.main()
