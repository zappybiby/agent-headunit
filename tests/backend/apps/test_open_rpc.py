from contextlib import nullcontext
import shlex
import unittest
from unittest.mock import Mock, call, patch

from frida import InvalidOperationError, ProcessNotFoundError

from apps.launcher import open_projected_app
from rpc import run as run_rpc
from projection.displays import GEARHEAD, LAUNCHER_WINDOW
from apps.lifecycle import close_app, intent_extras, open_deep_link, open_with_extras
from apps.service_links import _androidx_binding, open_service_link
from accessibility.renderer import read_windows
from projection.connection import Connection, HeadunitError, NoVisibleProjection, SceneChanged, StaleProjectedControl


PHONE = "emulator-5554"
DISPLAY = 8
PID = 2351
MAPS = "com.google.android.apps.maps"
COMPONENT = f"{MAPS}/{MAPS}.GmmCarProjectionService"
APP = {"package": MAPS, "component": COMPONENT, "profile": "PERSONAL"}
TILE = {"display": DISPLAY, "ref": "tile", "className": "android.view.View", "actions": ["press"]}
TITLE = {"display": DISPLAY, "ref": "title", "parent": "tile", "className": "android.widget.TextView",
         "text": "Maps", "actions": []}


class OpenRpcTest(unittest.TestCase):
    def setUp(self):
        self.unit = Mock()
        self.unit.press.return_value = {"ok": True}
        self.launcher_apps = self.start_patch("apps.launcher.launcher_apps", {"apps": [APP]})
        self.component_labels = self.start_patch("apps.launcher.component_labels", [
            {"component": COMPONENT, "label": "Maps"},
        ])
        self.adb = self.start_patch("apps.launcher.adb", "launcher window dump")
        self.window_records = self.start_patch("apps.launcher.window_records", [(None, (DISPLAY, GEARHEAD), PID)])

    def start_patch(self, target, value):
        patcher = patch(target, return_value=value)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def open_app(self, nodes):
        scene = self.launcher_scene(nodes)
        self.unit.snapshot.return_value = scene
        return open_projected_app(self.unit, scene, f"{MAPS}/.GmmCarProjectionService")

    def launcher_scene(self, nodes):
        return {"serial": PHONE, "nodes": nodes, "displays": [
            {"id": DISPLAY, "carWindow": LAUNCHER_WINDOW, "owner": GEARHEAD,
             "hitRegions": [[0, 0, 864, 1920]]},
        ]}

    def test_opens_a_compose_tile_by_its_exact_text_and_clickable_parent(self):
        nodes = [
            TILE, TITLE,
            dict(TITLE, ref="subtitle", text="Maps preview"),
            dict(TITLE, ref="outside-launcher", display=9),
            dict(TITLE, ref="standalone", parent=None),
        ]

        self.assertEqual(self.open_app(nodes), {"ok": True})
        self.launcher_apps.assert_called_once_with(PHONE)
        self.adb.assert_called_once_with(PHONE, "shell", "dumpsys", "window", "windows")
        self.component_labels.assert_called_once_with(PHONE, PID, [APP])
        self.unit.press.assert_called_once_with("ref=title", observed=self.unit.snapshot.return_value)

    def test_reselects_the_original_component_once_after_a_refused_guard(self):
        first = self.launcher_scene([TILE, TITLE])
        fresh = self.launcher_scene([
            TILE, TITLE, dict(TITLE, ref="refreshed-title", text="Google Maps"),
        ])
        self.unit.snapshot.side_effect = [first, fresh]
        self.component_labels.side_effect = [
            [{"component": COMPONENT, "label": "Maps"}],
            [{"component": COMPONENT, "label": "Google Maps"},
             {"component": "other.app/other.app.Service", "label": "Maps"}],
        ]
        self.unit.press.side_effect = [StaleProjectedControl("stale guard"), {"ok": True}]

        self.assertEqual(open_projected_app(self.unit, first, COMPONENT), {"ok": True})
        self.assertEqual(self.unit.press.call_args_list, [
            call("ref=title", observed=first),
            call("ref=refreshed-title", observed=fresh),
        ])
        self.assertEqual(self.component_labels.call_count, 2)

    def test_a_second_stale_guard_is_returned_without_another_retry(self):
        self.unit.press.side_effect = StaleProjectedControl("still stale")

        with self.assertRaisesRegex(StaleProjectedControl, "still stale"):
            self.open_app([TILE, TITLE])

        self.assertEqual(self.unit.snapshot.call_count, 2)
        self.assertEqual(self.unit.press.call_count, 2)

    def test_an_ordinary_press_error_with_the_same_message_is_not_retried(self):
        self.unit.press.side_effect = HeadunitError("The control changed. Capture a new snapshot.")

        with self.assertRaisesRegex(HeadunitError, "The control changed"):
            self.open_app([TILE, TITLE])

        self.unit.snapshot.assert_called_once_with()
        self.unit.press.assert_called_once()

    def test_the_renderer_distinguishes_guard_refusal_from_action_failure(self):
        device = Mock()
        capture = device.attach.return_value.create_script.return_value.exports_sync.snapshot
        panels = [{"id": DISPLAY, "owner": GEARHEAD}]
        window = "af Apps"
        records = [(window, (DISPLAY, GEARHEAD), PID)]
        target = {"display": DISPLAY, "windowId": 4, "windowKey": window, "guard": "old", "action": "press"}
        with (patch("accessibility.renderer.managed_device", return_value=nullcontext(device)),
              patch("accessibility.renderer.java_agent", return_value="agent")):
            capture.return_value = {"status": "guard-changed"}
            with self.assertRaisesRegex(StaleProjectedControl, "The control changed"):
                read_windows(PHONE, panels, records, target)
            capture.return_value = False
            with self.assertRaisesRegex(ValueError, "Android did not perform"):
                read_windows(PHONE, panels, records, target)

    def test_the_renderer_retries_only_reads_and_actions_that_never_reached_the_window(self):
        device = Mock()
        attachment = device.attach.return_value
        capture = attachment.create_script.return_value.exports_sync.snapshot
        capture.side_effect = InvalidOperationError("script has been destroyed")
        attachment.detach.side_effect = InvalidOperationError("session is detached")
        panels = [{"id": DISPLAY, "owner": GEARHEAD}]
        window = "af Apps"
        records = [(window, (DISPLAY, GEARHEAD), PID)]
        target = {"display": DISPLAY, "windowId": 4, "windowKey": window, "guard": "old", "action": "press"}
        with (patch("accessibility.renderer.managed_device", return_value=nullcontext(device)),
              patch("accessibility.renderer.java_agent", return_value="agent")):
            with self.assertRaisesRegex(SceneChanged, "changed while reading"):
                read_windows(PHONE, panels, records)
            with self.assertRaisesRegex(HeadunitError, "Check the current screen") as lost_action:
                read_windows(PHONE, panels, records, target)
            self.assertIs(type(lost_action.exception), HeadunitError)
            device.attach.side_effect = ProcessNotFoundError("process exited")
            with self.assertRaisesRegex(StaleProjectedControl, "changed before input"):
                read_windows(PHONE, panels, records, target)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(attachment.detach.call_count, 2)

    def test_missing_or_duplicate_visible_tile_refuses_before_press(self):
        for titles in ([], [TITLE, dict(TITLE, ref="second-title")]):
            with self.subTest(matches=len(titles)):
                with self.assertRaisesRegex(HeadunitError, "one visible launcher tile"):
                    self.open_app([TILE, *titles])
        self.unit.press.assert_not_called()

    def test_missing_or_duplicate_launcher_component_refuses_before_press(self):
        for apps in ([], [APP, dict(APP)]):
            with self.subTest(matches=len(apps)):
                self.launcher_apps.return_value = {"apps": apps}
                with self.assertRaisesRegex(HeadunitError, "one personal launcher component"):
                    self.open_app([TILE, TITLE])
        self.component_labels.assert_not_called()
        self.unit.press.assert_not_called()

    def test_opening_the_focused_component_leaves_its_current_screen_in_place(self):
        scene = {"serial": PHONE, "displays": [
            {"id": DISPLAY, "owner": MAPS, "appFocused": True, "components": [COMPONENT]},
        ]}
        self.assertEqual(open_projected_app(self.unit, scene, MAPS),
                         {"ok": True, "package": MAPS, "component": COMPONENT})
        self.unit.snapshot.assert_not_called()
        self.unit.press.assert_not_called()
        self.component_labels.assert_not_called()

    def test_native_app_reports_current_android_streaming_block(self):
        self.launcher_apps.return_value = {"apps": [dict(APP, native=True)]}
        self.window_records.return_value = [
            ("aa android/com.android.internal.app.BlockedAppStreamingActivity", (DISPLAY, "android"), PID),
        ]
        scene = {"serial": PHONE, "displays": [
            {"id": DISPLAY, "owner": MAPS, "appFocused": True, "activity": COMPONENT},
        ]}
        with self.assertRaisesRegex(HeadunitError, f"Android blocked {MAPS} from opening on car display {DISPLAY}"):
            open_projected_app(self.unit, scene, MAPS)
        self.unit.press.assert_not_called()

    def test_launch_extras_preserve_values_and_cannot_override_the_projected_target(self):
        extras = ["--es", "title", "One & Two", "--ez", "fresh", "true", "--esn", "optional", "--activity-single-top"]
        self.assertEqual(shlex.split(" ".join(intent_extras(extras))), extras)
        for invalid in (["--es", "title"], ["--display", "0"], ["-n", "other.app/.Activity"]):
            with self.subTest(arguments=invalid), self.assertRaisesRegex(HeadunitError, "Intent extras"):
                intent_extras(invalid)


class IntentOpenRpcTest(unittest.TestCase):
    def setUp(self):
        self.unit = Mock()
        self.unit.connection.serial = PHONE
        self.package = "example.projected"
        self.entry = f"{self.package}/{self.package}.CarEntry"
        self.handler = f"{self.package}/{self.package}.Editor"
        self.app = {"package": self.package, "component": self.entry, "native": True, "profile": "PERSONAL"}
        self.tree = {"serial": PHONE, "displays": []}
        self.launch = Mock()

    def test_bare_url_selects_the_registered_projected_handler_from_the_launcher(self):
        receiver_default = "android/com.android.internal.app.ResolverActivity"
        with (patch("apps.lifecycle.launcher_apps", return_value={"apps": [self.app]}),
              patch("apps.lifecycle.adb", side_effect=[receiver_default, f"browser.app/.Main\n{self.handler}", "true"]) as adb,
              patch("apps.lifecycle._start_projected_activity", return_value={"package": self.package}) as start):
            result = open_deep_link(self.unit, self.tree, None, "fixture://event/test", self.launch)
        self.assertEqual(result, {"package": self.package})
        self.assertEqual([call.args[4] for call in adb.call_args_list[:2]], ["resolve-activity", "query-activities"])
        start.assert_called_once_with(self.unit, self.tree, self.app, self.handler,
                                      ["-a", "android.intent.action.VIEW", "-d", "fixture://event/test"], self.launch)

    def test_bare_url_refuses_multiple_projected_handlers_before_start(self):
        second = dict(self.app, package="other.app", component="other.app/other.app.CarEntry")
        with (patch("apps.lifecycle.launcher_apps", return_value={"apps": [self.app, second]}),
              patch("apps.lifecycle.adb", side_effect=["", f"{self.handler}\nother.app/.Another"]),
              patch("apps.lifecycle._start_projected_activity") as start):
            with self.assertRaisesRegex(HeadunitError, "one projected activity"):
                open_deep_link(self.unit, self.tree, None, "fixture://event/test", self.launch)
        start.assert_not_called()

    def test_activity_override_reuses_the_single_resumed_task_of_its_app_on_the_car_display(self):
        self.tree["displays"] = [{"id": DISPLAY, "activity": self.entry, "owner": self.package,
                                  "appFocused": True, "uniqueId": "fixture-panel"}]
        another = f"{self.package}/{self.package}.Details"
        with (patch("apps.lifecycle.launcher_apps", return_value={"apps": [self.app]}),
              patch("apps.lifecycle.adb", side_effect=["true", self.handler, f"Status: ok\nActivity: {self.handler}"]) as adb,
              patch("apps.lifecycle._display_is_current", return_value=True),
              patch("apps.lifecycle.resumed_activities", side_effect=[{(another, 22)}, {(self.handler, 22)}])):
            result = open_with_extras(self.unit, self.tree, self.package, ["--es", "entry", "car"],
                                      self.launch, activity=".Editor")
        self.assertEqual(result["component"], self.handler)
        self.assertEqual(result["display"], DISPLAY)
        self.assertEqual(adb.call_args.args[3:9], ("start", "-W", "--user", "current", "--display", str(DISPLAY)))
        self.assertEqual(adb.call_args.args[-5:], ("--es", "entry", "car", "-n", self.handler))
        self.launch.assert_not_called()


class CloseRpcTest(unittest.TestCase):
    def test_close_reaps_the_projected_app_after_its_display_has_gone(self):
        target = dict(APP, native=False)
        force_stop = (PHONE, "shell", "am", "force-stop", "--user", "current", MAPS)
        with (patch("projection.connection.panels_on", return_value=[]) as panels,
              patch("apps.lifecycle.launcher_apps", return_value={"apps": [target]}) as catalog,
              patch("apps.lifecycle._phone_displays", return_value=[]),
              patch("apps.lifecycle.adb", side_effect=[
                  f"PID NAME\n{PID} {MAPS}\n", "", "", "PID NAME\n",
              ]) as adb):
            self.assertTrue(run_rpc({"op": "close", "serial": PHONE, "target": MAPS})["closed"])
        panels.assert_called_once_with(PHONE)
        catalog.assert_called_once_with(PHONE)
        self.assertEqual(adb.call_args_list[1].args, force_stop)

    def test_empty_projection_requires_an_explicit_matching_serial_and_a_close(self):
        for request in ({"op": "close", "target": MAPS},
                        {"op": "close", "serial": "emulator-5556", "target": MAPS},
                        {"op": "snapshot", "serial": PHONE}):
            with (self.subTest(request=request),
                  patch("projection.connection.Connection.connect", return_value=Connection(PHONE, None)),
                  patch("projection.connection.panels_on", return_value=[]),
                  patch("apps.lifecycle.close_app") as close):
                with self.assertRaises(NoVisibleProjection):
                    run_rpc(request)
                close.assert_not_called()

    def test_close_propagates_other_snapshot_failures_even_with_the_same_message(self):
        error = HeadunitError("No matching visible Android Auto panel. Check the Open Headunit connection and retry.")
        with (patch("projection.connection.panels_on", side_effect=error), patch("apps.lifecycle.close_app") as close):
            with self.assertRaises(HeadunitError) as raised:
                run_rpc({"op": "close", "serial": PHONE, "target": MAPS})
        self.assertIs(raised.exception, error)
        close.assert_not_called()

    def test_close_of_an_inactive_projected_app_does_not_send_force_stop(self):
        unit = Mock()
        unit.connection.serial = PHONE
        scene = {"serial": PHONE, "displays": []}
        with (patch("apps.lifecycle.launcher_apps", return_value={"apps": [APP]}),
              patch("apps.lifecycle._phone_displays", return_value=[]),
              patch("apps.lifecycle.adb", return_value="PID NAME\n") as adb):
            self.assertFalse(close_app(unit, scene, MAPS)["closed"])
        adb.assert_called_once_with(PHONE, "shell", "ps", "-A", "-o", "PID,NAME")


class RelaunchRpcTest(unittest.TestCase):
    def setUp(self):
        self.app = dict(APP, native=False)
        screen = {"width": 800, "height": 480}
        self.foreground = [{"owner": MAPS, "appFocused": True, "components": [COMPONENT],
                            "id": DISPLAY, "screen": screen}]
        self.launcher = [{"owner": GEARHEAD, "carWindow": LAUNCHER_WINDOW, "id": 2, "screen": screen}]
        self.request = {"op": "relaunch", "serial": PHONE, "target": MAPS}

    def test_relaunch_waits_through_empty_projection_before_and_after_launch(self):
        with (patch("projection.connection.panels_on", side_effect=[self.foreground, [], self.launcher, [], self.foreground]),
              patch("apps.lifecycle.launcher_apps", return_value={"apps": [self.app]}),
              patch("apps.lifecycle._phone_displays", return_value=[]),
              patch("apps.lifecycle.adb", side_effect=[f"PID NAME\n{PID} {MAPS}\n", "", "", "PID NAME\n"]) as adb,
              patch("apps.lifecycle.time.sleep") as sleep,
              patch("rpc.open_projected_app", return_value={"ok": True}) as launch):
            self.assertEqual(run_rpc(self.request), {"ok": True, "package": MAPS, "component": COMPONENT})
        self.assertEqual(adb.call_args_list[1].args, (PHONE, "shell", "am", "force-stop", "--user", "current", MAPS))
        self.assertEqual(adb.call_count, 4)
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[1]["displays"], self.launcher)
        self.assertEqual(launch.call_args.args[2], COMPONENT)
        self.assertEqual(sleep.call_count, 2)

    def test_relaunch_uses_one_projection_deadline_and_does_not_resend_launch(self):
        with (patch("projection.connection.panels_on", side_effect=[self.foreground, [], self.launcher, []]),
              patch("apps.lifecycle.launcher_apps", return_value={"apps": [self.app]}),
              patch("apps.lifecycle._close_running_app") as close,
              patch("apps.lifecycle.time.monotonic", side_effect=[0, 7.95, 8]),
              patch("apps.lifecycle.time.sleep") as sleep,
              patch("rpc.open_projected_app", return_value={"ok": True}) as launch):
            with self.assertRaises(NoVisibleProjection):
                run_rpc(self.request)
        close.assert_called_once()
        launch.assert_called_once()
        sleep.assert_called_once()
        self.assertAlmostEqual(sleep.call_args.args[0], 0.05)

    def test_relaunch_propagates_other_snapshot_errors_without_repeating_launch(self):
        error = HeadunitError("No matching visible Android Auto panel. Check the Open Headunit connection and retry.")
        with (patch("projection.connection.panels_on", side_effect=[self.foreground, self.launcher, error]),
              patch("apps.lifecycle.launcher_apps", return_value={"apps": [self.app]}),
              patch("apps.lifecycle._close_running_app") as close,
              patch("apps.lifecycle.time.sleep") as sleep,
              patch("rpc.open_projected_app", return_value={"ok": True}) as launch):
            with self.assertRaises(HeadunitError) as raised:
                run_rpc(self.request)
        self.assertIs(raised.exception, error)
        close.assert_called_once()
        launch.assert_called_once()
        sleep.assert_not_called()


class ServiceLinkRpcTest(unittest.TestCase):
    def setUp(self):
        self.component = "example.projected/example.projected.LinkService"
        self.app = {"package": "example.projected", "component": self.component, "profile": "PERSONAL", "category": "POI"}
        self.tree = {"serial": PHONE, "displays": [{"owner": GEARHEAD, "id": 25, "uniqueId": "template-panel",
                                                    "hitRegions": [[0, 0, 200, 200]], "carWindow": "TemplateCarActivity"}]}
        self.unit = Mock()
        self.unit.connection.serial = PHONE
        self.unit.connection.snapshot.return_value = self.tree

    def test_app_side_binding_requires_a_visible_primary_region_and_current_user_service(self):
        region = "CarRegionId{regionId=5 carDisplayId=CarDisplayId{displayId=0}}"
        dump = ("-- ProjectionWindowManager for display CarDisplayId{displayId=0}\n"
                "Windows by layout z -- the order used for rendering:\n"
                f"  {{name=TemplateCarActivity,region={region},z=2,vis=true,a=1,surface=stream}}\n"
                "Active windows by z -- order used for focus:\n"
                f"Current app ProjectionApp(appKey=AppKey(componentName=ComponentInfo{{{self.component}}},"
                f" profileType=PERSONAL), appCategory=POI) on region {region}\n")
        services = ("SERVICE example.projected/.LinkService aa pid=3472 user=0\n"
                    "SERVICE example.projected/.LinkService bb pid=6512 user=10\n")
        with patch("apps.service_links.adb", side_effect=[dump, services, dump.replace("vis=true", "vis=false")]):
            self.assertEqual(_androidx_binding(self.tree, self.component, 0), (3472, 5, 25, "template-panel"))
            self.assertIsNone(_androidx_binding(self.tree, self.component, 0))

    def test_only_an_explicit_predispatch_refusal_can_fall_back_on_the_pinned_host(self):
        device = Mock()
        exports = device.attach.return_value.create_script.return_value.exports_sync
        match = {"component": self.component, "pid": 3472, "hostUid": 10132, "session": "session", "service": "service"}
        exports.probe.return_value = {"status": "ready", "match": match}
        with (patch("apps.service_links._check_support"), patch("apps.service_links._pinned_gearhead", return_value=True),
              patch("apps.service_links._current_user_and_host", return_value=(0, 10132)),
              patch("apps.service_links._androidx_binding", return_value=(3472, 5, 25, "template-panel")),
              patch("apps.service_links.java_agent", return_value="agent"),
              patch("apps.service_links.managed_device", side_effect=lambda _: nullcontext(device)),
              patch("apps.service_links._dispatch", return_value={"ok": True}) as pinned):
            exports.deliver.return_value = {"status": "unsupported", "error": "Predispatch refusal"}
            self.assertEqual(open_service_link(self.unit, self.tree, self.app, "fixture://new"), {"ok": True})
            pinned.assert_called_once_with(self.tree, self.component, "fixture://new")
            pinned.reset_mock()

            exports.deliver.side_effect = ValueError("Transport disconnected during send")
            with self.assertRaisesRegex(HeadunitError, "may have reached the app"):
                open_service_link(self.unit, self.tree, self.app, "fixture://once")
            pinned.assert_not_called()

            exports.deliver.side_effect = None
            exports.deliver.return_value = {"status": "accepted"}
            result = open_service_link(self.unit, self.tree, self.app, "fixture://accepted")
            self.assertEqual(result["method"], "androidx-session")
            self.assertEqual(result["display"], 25)
            pinned.assert_not_called()
