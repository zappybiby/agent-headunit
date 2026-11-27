"""Exercise Metro reverse ownership without ADB or an emulator."""

import unittest
from unittest.mock import patch

from agent_rpc import HeadunitError, port_reverse


SERIAL = "emulator-5554"
TOKEN = "a" * 32
MARKER = "localabstract:agent-device-headunit-" + TOKEN
REQUEST = {"serial": SERIAL, "transportId": "12", "devicePort": 8081, "hostPort": 8082, "token": TOKEN}


class ReverseTests(unittest.TestCase):
    transport_id = "12"
    state = "device"

    def setUp(self):
        self.mappings = {}
        self.commands = []

    def adb(self, serial, *args, transport_id=None):
        if args == ("devices", "-l"):
            self.assertIsNone(serial)
            return f"List of devices attached\n{SERIAL} {self.state} transport_id:{self.transport_id}\n"
        self.assertEqual((serial, transport_id), (SERIAL, self.transport_id))
        self.assertEqual(args[0], "reverse")
        self.commands.append(args[1:])
        if args[1] == "--list":
            return "\n".join(f"host {source} {target}" for source, target in self.mappings.items())
        if args[1] == "--remove":
            self.mappings.pop(args[2])
        elif args[1] == "--no-rebind":
            if args[2] in self.mappings:
                raise HeadunitError("Already forwarded")
            self.mappings[args[2]] = args[3]
        else:
            self.mappings[args[1]] = args[2]
        return ""

    def test_creates_and_cleans_only_exact_owned_forwarding(self):
        self.mappings["tcp:7777"] = "tcp:7777"
        with patch("agent_rpc.adb", side_effect=self.adb):
            self.assertEqual(port_reverse(REQUEST), {"ok": True, "created": True})
            self.assertIn(("--no-rebind", "tcp:8081", "tcp:8082"), self.commands)
            self.assertEqual(self.mappings[MARKER], "tcp:8082")
            port_reverse(dict(REQUEST, remove=True))
        self.assertEqual(self.mappings, {"tcp:7777": "tcp:7777"})

    def test_replacement_transport_never_receives_reverse(self):
        self.transport_id = "13"
        self.mappings["tcp:8081"] = "tcp:8082"
        with patch("agent_rpc.adb", side_effect=self.adb):
            port_reverse(dict(REQUEST, remove=True))
            with self.assertRaisesRegex(HeadunitError, "changed"):
                port_reverse(REQUEST)
        self.assertEqual(self.commands, [])
        self.assertEqual(self.mappings, {"tcp:8081": "tcp:8082"})

    def test_reused_transport_id_without_marker_preserves_existing_mapping(self):
        self.mappings["tcp:8081"] = "tcp:8082"
        with patch("agent_rpc.adb", side_effect=self.adb):
            self.assertEqual(port_reverse(REQUEST), {"ok": True, "created": False})
            port_reverse(dict(REQUEST, remove=True))
        self.assertEqual(self.commands, [("--list",), ("--list",)])
        self.assertEqual(self.mappings, {"tcp:8081": "tcp:8082"})

    def test_pending_marker_cannot_authorize_removing_an_unconfirmed_mapping(self):
        self.mappings.update({MARKER: MARKER + "-pending", "tcp:8081": "tcp:8082"})
        with patch("agent_rpc.adb", side_effect=self.adb):
            port_reverse(dict(REQUEST, remove=True))
        self.assertEqual(self.mappings, {"tcp:8081": "tcp:8082"})

    def test_offline_transport_preserves_cleanup_attempt(self):
        self.state = "offline"
        with patch("agent_rpc.adb", side_effect=self.adb):
            with self.assertRaisesRegex(HeadunitError, "not ready"):
                port_reverse(dict(REQUEST, remove=True))
        self.assertEqual(self.commands, [])


if __name__ == "__main__":
    unittest.main()
