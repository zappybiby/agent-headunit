import hashlib
from io import BytesIO
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "windows"))
import assets
import avds
import windows.setup as setup


class SetupTests(unittest.TestCase):
    def test_inventory_uses_emulator_names_and_follows_external_avd_paths(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            avd = root / "Device files"
            avd.mkdir()
            (avd / "config.ini").write_text("abi.type=arm64-v8a\ntag.id=google_apis\n")
            for name in ("Tablet", "Stale"):
                (root / (name + ".ini")).write_text(f"path={avd}\n")
            with patch.dict(os.environ, ANDROID_AVD_HOME=tmp), patch.object(
                avds.subprocess, "check_output", return_value="Tablet\n"
            ):
                self.assertEqual(avds.inventory("emulator"), {"Tablet": ("arm64-v8a", "google_apis")})

    def test_saved_and_explicit_roles_and_noninteractive_ambiguity(self):
        devices = dict.fromkeys(("Daily", "Test", "Car"), ("x86_64", "google_apis"))
        saved = {"phoneAvd": "Daily", "receiverAvd": "Car"}
        self.assertEqual(avds.choose_pair(devices, None, None, saved), ("Daily", "Car"))
        self.assertEqual(avds.choose_pair(devices, "Test", None, saved), ("Test", "Car"))
        with patch.object(sys.stdin, "isatty", return_value=False):
            with self.assertRaisesRegex(ValueError, "--phone-avd"):
                avds.choose_pair(devices, None, None, {})
        with self.assertRaisesRegex(ValueError, "different"):
            avds.choose_pair(devices, "Test", "Test", saved)

    def test_asset_cache_rejects_bad_bytes_and_repairs_a_corrupt_download(self):
        with TemporaryDirectory() as tmp:
            payload = b"upstream file"
            spec = {"url": "https://example.test/package.xz", "sha256": hashlib.sha256(payload).hexdigest()}
            with patch.object(assets, "urlopen", side_effect=[BytesIO(payload), BytesIO(b"bad"), BytesIO(payload)]) as fetch:
                path = assets.release_file(Path(tmp), spec)
                self.assertEqual(assets.release_file(Path(tmp), spec), path)
                self.assertEqual(fetch.call_count, 1)
                path.write_bytes(b"incomplete")
                with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
                    assets.release_file(Path(tmp), spec)
                self.assertEqual(assets.release_file(Path(tmp), spec).read_bytes(), payload)

    def test_prepared_receiver_keeps_its_app_and_custom_build_targets_only_that_receiver(self):
        installed = "package:" + setup.RECEIVER
        with patch.object(setup, "adb", return_value=installed) as adb, patch.object(setup, "release_file") as fetch, \
                patch.object(setup.subprocess, "run") as run:
            setup.install_receiver("emulator-5582", Path("cache"), {}, None)
            run.assert_not_called()
            apk = Path("developer.apk")
            setup.install_receiver("emulator-5582", Path("cache"), {}, apk)
            run.assert_called_once_with(["adb", "-s", "emulator-5582", "install", "-r", str(apk)], check=True)
            fetch.assert_not_called()
            self.assertTrue(all(call.args[0] == "emulator-5582" for call in adb.call_args_list))
