import unittest
from unittest.mock import patch

from rpc import run
from projection.displays import GEARHEAD
from projection.connection import HeadunitError


PHONE = "emulator-5554"
MAPS = "com.google.android.apps.maps"
HANDSET = "com.example.handset"


def visible_window(display, package):
    return f"""
  Window #{display} Window{{abcdef{display} u0 {package}}}:
    mDisplayId={display}
    mOwnerUid=10133 package={package} appop=NONE
    isVisible=true
"""


class AppStateRpcTest(unittest.TestCase):
    @patch("rpc.adb")
    @patch("headunit.Headunit")
    def test_reports_the_focused_projection_service_owner_without_an_activity(self, headunit, adb):
        connection = headunit.return_value.connection
        connection.snapshot.return_value = {"serial": PHONE, "displays": [
            {"id": 4, "owner": MAPS, "appFocused": True, "components": [f"{MAPS}/GmmCarProjectionService"]},
            {"id": 8, "owner": GEARHEAD},
        ]}
        adb.return_value = (f"mCurrentFocus=Window{{abcd u0 {HANDSET}/.Main}}\n"
                            + visible_window(0, HANDSET) + visible_window(4, MAPS))

        self.assertEqual(run({"op": "appstate", "serial": PHONE}), {"ok": True, "package": MAPS})
        connection.snapshot.assert_called_once_with(include_nodes=False)
        adb.assert_called_once_with(PHONE, "shell", "dumpsys", "window", "windows")

    @patch("rpc.adb")
    @patch("headunit.Headunit")
    @patch("apps.lifecycle.adb")
    def test_reports_the_actual_activity_on_a_focused_native_display(self, activity_adb, headunit, adb):
        package = "lab.headunit.wordgrid"
        activity = package + ".Details"
        headunit.return_value.connection.snapshot.return_value = {"serial": PHONE, "displays": [
            {"id": 70, "owner": package, "appFocused": True, "activity": f"{package}/{package}.WordGrid"},
        ]}
        adb.return_value = visible_window(70, package)
        activity_adb.return_value = (
            f"Display #0 (activities from top to bottom):\n  Resumed: ActivityRecord{{aa u0 {HANDSET}/.Main t40}}\n"
            f"Display #70 (activities from top to bottom):\n  topResumedActivity=ActivityRecord{{bb u0 {package}/.Details t42}}\n"
        )

        self.assertEqual(run({"op": "appstate"}), {"ok": True, "package": package, "activity": activity})

    @patch("rpc.adb")
    @patch("headunit.Headunit")
    def test_refuses_to_report_the_handset_or_a_changed_projected_window(self, headunit, adb):
        headunit.return_value.connection.snapshot.return_value = {"serial": PHONE, "displays": [
            {"id": 4, "owner": MAPS, "appFocused": True},
        ]}
        adb.return_value = visible_window(0, MAPS) + visible_window(4, HANDSET)

        with self.assertRaisesRegex(HeadunitError, "window changed"):
            run({"op": "appstate"})

    @patch("rpc.adb")
    @patch("headunit.Headunit")
    def test_unidentified_or_ambiguous_focus_refuses_before_reading_android_windows(self, headunit, adb):
        for selected in (False, True):
            with self.subTest(selected=selected):
                headunit.return_value.connection.snapshot.return_value = {"serial": PHONE, "displays": [
                    {"id": 4, "owner": MAPS, "appFocused": selected},
                    {"id": 8, "owner": GEARHEAD, "appFocused": selected},
                ]}
                with self.assertRaisesRegex(HeadunitError, "one focused projected app window"):
                    run({"op": "appstate"})
        adb.assert_not_called()
