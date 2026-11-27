from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

import open_headunit_session as bootstrap
from transport import HeadunitError


PHONE = "emulator-5554"
RECEIVER = "emulator-5556"


class ReadinessTest(unittest.TestCase):
    def run_bootstrap(self, directory):
        server = Path(directory) / "frida-server"
        server.touch()
        args = ["open_headunit_session.py", "--phone-avd", "Phone", "--receiver-avd", "Receiver",
                "--frida-server", str(server), "--managed-service"]
        stderr = StringIO()
        with patch.object(sys, "argv", args), redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as exit_result:
                bootstrap.main()
        self.assertEqual(exit_result.exception.code, 1)
        return stderr.getvalue()

    def test_missing_python_dependency_fails_before_a_managed_pair_starts(self):
        with (TemporaryDirectory() as directory, patch.dict(sys.modules, {"frida": None}),
              patch("open_headunit_session.prepare_pair") as prepare,
              patch("open_headunit_session.Thread") as watcher):
            self.assertIn("Install frida and frida-tools", self.run_bootstrap(directory))
            prepare.return_value.__enter__.assert_not_called()
            watcher.assert_not_called()

    def test_unknown_avd_reports_its_name_without_starting_an_emulator(self):
        with (TemporaryDirectory() as directory,
              patch("open_headunit_session.require_frida", return_value=Mock()),
              patch("open_headunit_session.Thread"),
              patch("avd_pair.running_avds", return_value={}),
              patch("avd_pair.emulator_executable", return_value="emulator"),
              patch("avd_pair.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "Phone\n", "")),
              patch("avd_pair.subprocess.Popen") as start):
            self.assertIn("AVDs not installed: Receiver", self.run_bootstrap(directory))
            start.assert_not_called()

    def test_duplicate_running_phone_is_rejected_before_launching_an_emulator(self):
        inventory = ("List of devices attached\n"
                     "emulator-5554\tdevice\n"
                     "emulator-5556\tdevice\n")
        with (TemporaryDirectory() as directory,
              patch("open_headunit_session.require_frida", return_value=Mock()),
              patch("open_headunit_session.Thread"),
              patch("avd_pair.adb", side_effect=[inventory, "Phone\n", "Phone\n"]),
              patch("avd_pair.subprocess.Popen") as start):
            self.assertIn("More than one emulator reports AVD Phone", self.run_bootstrap(directory))
            start.assert_not_called()

    def test_denied_root_is_reported_before_staging_the_server_or_forward(self):
        for refusal in ("2000\n", HeadunitError("Permission denied by root manager")):
            with (self.subTest(refusal=refusal),
                  patch("open_headunit_session.receiver_serial"),
                  patch("open_headunit_session.Connection.connect"),
                  patch("open_headunit_session.adb",
                        side_effect=["1\n", "device\n", "2000\n", "/system/bin/su\n", refusal]) as adb):
                with self.assertRaisesRegex(HeadunitError, "root on emulator-5554|root was denied on emulator-5554"):
                    with bootstrap.frida_session(PHONE, RECEIVER, Path("server"), 60, Path("."), frida=Mock()):
                        self.fail("The service reached readiness without root")
                self.assertEqual([call.args[1] for call in adb.call_args_list],
                                 ["shell", "get-state", "shell", "shell", "shell"])

    def test_disconnected_projection_reports_how_to_connect_before_staging(self):
        with (patch("open_headunit_session.receiver_serial"),
              patch("transport.panels_on", return_value=[]),
              patch("open_headunit_session.adb", side_effect=["1\n", "device\n"]) as adb):
            with self.assertRaisesRegex(HeadunitError, "Connect Open Headunit on emulator-5556 to Android Auto on emulator-5554"):
                with bootstrap.frida_session(PHONE, RECEIVER, Path("server"), 60, Path("."), frida=Mock()):
                    self.fail("The service reached readiness without projection")
            self.assertEqual(adb.call_count, 2)
