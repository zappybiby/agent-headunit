import unittest
import json
import os
import tempfile
from unittest.mock import MagicMock, patch

from apps.launcher import GEARHEAD_SERVICE, component_labels, launcher_apps, parse_launcher_apps


DUMP = """Other state
=== AVAILABLE_APP_FINDER ===
Last returned launcher components:
|Category  |Component name |
|OTHER     |ProjectionApp(appKey=AppKey(componentName=ComponentInfo{com.google.android.projection.gearhead/com.google.android.apps.auto.components.gearsnacks.GearSnacksService}, profileType=PERSONAL), appCategory=OTHER, isParkedOnly=true, isImmersiveApp=false, isNativeApp=false) |
|NAVIGATION|ProjectionApp(appKey=AppKey(componentName=ComponentInfo{com.google.android.apps.maps/.GmmCarProjectionService}, profileType=PERSONAL), appCategory=NAVIGATION, isParkedOnly=false, isImmersiveApp=false, isNativeApp=false) |

9 app providers:
=== OTHER_SECTION ===
"""


class LauncherTest(unittest.TestCase):
    def test_finder_preserves_components_and_flags(self):
        result = parse_launcher_apps(DUMP)
        self.assertEqual(result["source"], "AVAILABLE_APP_FINDER")
        game, maps = result["apps"]
        self.assertEqual(game, {
            "package": "com.google.android.projection.gearhead",
            "component": "com.google.android.projection.gearhead/com.google.android.apps.auto.components.gearsnacks.GearSnacksService",
            "profile": "PERSONAL", "category": "OTHER", "parkedOnly": True,
            "immersive": False, "native": False,
        })
        self.assertEqual(maps["component"], "com.google.android.apps.maps/com.google.android.apps.maps.GmmCarProjectionService")
        self.assertFalse(maps["parkedOnly"])

    def test_missing_or_unrecognized_data_fails(self):
        for text in ("", "=== AVAILABLE_APP_FINDER ===", DUMP.replace("|Category  |Component name |", ""), DUMP.replace("isNativeApp=false", "isNativeApp=unknown")):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_launcher_apps(text)

    def test_reads_service_for_requested_phone(self):
        with patch("apps.launcher.adb", return_value=DUMP) as adb:
            self.assertEqual(len(launcher_apps("emulator-5554")["apps"]), 2)
        adb.assert_called_once_with("emulator-5554", "shell", "dumpsys", "activity", "service", GEARHEAD_SERVICE)

    def test_label_lookup_sends_components_as_rpc_data(self):
        manager = MagicMock()
        script = manager.add_remote_device.return_value.attach.return_value.create_script.return_value
        script.exports_sync.labels.return_value = [{"component": "pkg/Service", "profile": "PERSONAL", "label": "Title"}]
        entries = [{"component": "pkg/Service", "profile": "PERSONAL", "native": False}]
        with tempfile.TemporaryDirectory() as directory:
            session = os.path.join(directory, "session.json")
            with open(session, "w", encoding="utf8") as file:
                json.dump({"serial": "phone", "port": 12345, "token": "token"}, file)
            with patch.dict(os.environ, HEADUNIT_FRIDA_SESSION=session), patch("frida.get_device_manager", return_value=manager):
                self.assertEqual(component_labels("phone", 42, entries)[0]["label"], "Title")
            script.exports_sync.labels.assert_called_once_with(entries)
            manager.add_remote_device.return_value.attach.return_value.detach.assert_called_once()
            manager.remove_remote_device.assert_called_once_with("127.0.0.1:12345")


if __name__ == "__main__":
    unittest.main()
