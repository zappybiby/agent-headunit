import unittest

from projection import FACET_BAR, GEARHEAD, GEARHEAD_TOOLTIP, TOUCH_IME, car_bounds, hit_panel, projection_displays, resolve_visible_panels, visible_panels


# Fields unrelated to display selection, such as the supported refresh rates, are omitted.
def logical_display(number, name, owner="com.google.android.projection.gearhead", *,
                    size="864 x 95", flags="FLAG_PRIVATE, FLAG_PRESENTATION",
                    state="ON", enabled=True):
    return f"""
  Display {number}:
    mDisplayId={number}
    mIsEnabled={str(enabled).lower()}
    mHasContent=false
    mBaseDisplayInfo=DisplayInfo{{"{name}", displayId {number}, displayGroupId 0, {flags}, real {size}, rotation 0, state {state}, committedState UNKNOWN, type VIRTUAL, uniqueId "virtual:{owner},10133,{name},3", app {size}, owner {owner} (uid 10133), removeMode 0}}
"""


class ProjectionDiscoveryTest(unittest.TestCase):
    def test_reads_logical_density_and_requires_override_dimensions_to_agree(self):
        display = logical_display(5, "GhFacetBar").replace(
            ", owner ", ", density 240 (72.0 x 83.0) dpi, owner ")
        panel, = projection_displays(display)
        self.assertEqual(panel["densityDpi"], 240)

        base_row = next(line for line in display.splitlines() if "mBaseDisplayInfo=" in line)
        override = base_row.replace("mBaseDisplayInfo=", "mOverrideDisplayInfo=").replace("density 240", "density 320")
        panel, = projection_displays(display + override)
        self.assertEqual(panel["densityDpi"], 320)
        panel, = projection_displays(display + override.replace("real 864 x 95", "real 800 x 95"))
        self.assertNotIn("densityDpi", panel)
        panel, = projection_displays(display + "    mOverrideDisplayInfo=null")
        self.assertEqual(panel["densityDpi"], 240)

    def test_parked_activity_owns_the_windows_on_gearheads_trusted_display(self):
        activity = "lab.headunit.wordgrid/lab.headunit.wordgrid.WordGrid"
        name = f"NativeDisplay:ComponentInfo{{{activity}}}"
        display = logical_display(70, name, flags="FLAG_SECURE, FLAG_TRUSTED", size="864 x 1920")
        panel, = projection_displays(display)
        self.assertEqual((panel["id"], panel["owner"], panel["activity"]), (70, "lab.headunit.wordgrid", activity))
        self.assertEqual(projection_displays(logical_display(71, name)), [])
        self.assertEqual(projection_displays(logical_display(72, name, owner="lab.other")), [])

    def test_dashboard_session(self):
        maps = "com.google.android.apps.maps"
        gearhead = "com.google.android.projection.gearhead"
        dump = "".join([
            logical_display(0, "Built-in Screen", owner="android"),
            logical_display(4, maps + "/pee", owner=maps, size="840 x 1813"),
            logical_display(3, f"GhostActivityDisplay:ComponentInfo{{{maps}/S}}"),
            logical_display(6, "Dashboard", size="840 x 220"),
            logical_display(5, "GhFacetBar"),
        ])
        self.assertEqual(projection_displays(dump), [
            {"id": 4, "name": maps + "/pee", "state": "ON", "owner": maps, "components": [f"{maps}/{maps}.S"],
             "width": 840, "height": 1813,
             "uniqueId": f"virtual:{maps},10133,{maps}/pee,3"},
            {"id": 5, "name": "GhFacetBar", "state": "ON", "owner": gearhead, "width": 864, "height": 95,
             "uniqueId": "virtual:com.google.android.projection.gearhead,10133,GhFacetBar,3"},
            {"id": 6, "name": "Dashboard", "state": "ON", "owner": gearhead, "width": 840, "height": 220,
             "uniqueId": "virtual:com.google.android.projection.gearhead,10133,Dashboard,3"},
        ])

    def test_foreign_displays_are_not_returned_for_an_active_car_app(self):
        maps = "com.google.android.apps.maps"
        dump = "".join([
            logical_display(3, f"GhostActivityDisplay:ComponentInfo{{{maps}/S}}"),
            logical_display(4, "other.app/Presentation", owner="other.app"),
            logical_display(5, "external", owner=maps),
            logical_display(6, "other.app/Presentation", owner=maps),
            logical_display(7, maps + "/Phone", owner=maps, flags="FLAG_PRIVATE"),
            logical_display(8, "GhostActivityDisplay:ComponentInfo{other.app/A}", state="OFF"),
        ])
        self.assertEqual(projection_displays(dump), [])


def render_window(name, vertices, *, transparent=False):
    return (f" juf@2abc{{name={name},region=CarRegionId{{regionId=1 carDisplayId=CarDisplayId{{displayId=0}}}},"
            f"l=1,s=2,vis=true,a=1.0,transparencyEnabled={str(transparent).lower()},vertices={vertices}}}")


class CarScreenTest(unittest.TestCase):
    def setUp(self):
        self.panels = projection_displays("".join([
            logical_display(3, "GhostActivityDisplay:ComponentInfo{com.example.maps/maps.GmmCarProjectionService}"),
            logical_display(4, "com.example.maps/pee", owner="com.example.maps", size="840 x 1813"),
            logical_display(5, "GhFacetBar"), logical_display(6, "Dashboard", size="840 x 220"),
            logical_display(7, f"GhostActivityDisplay:ComponentInfo{{{GEARHEAD}/.system.applauncher.GhAppLauncherService}}"),
            logical_display(8, GEARHEAD + "/nfn", size="840 x 900"),
        ]))
        self.map_layer = render_window("GmmCarProjectionService", [12, 95, 852, 1908])
        self.dashboard = render_window(GEARHEAD + ":Dashboard", [12, 95, 852, 315], transparent=True)
        self.launcher = render_window("GhAppLauncherService", [12, 95, 852, 995])
        self.rail = render_window(FACET_BAR, [0, 0, 864, 95], transparent=True)

    def report(self, *layers, focus="", current=None, history=()):
        return "\n".join(["  Display #0", "    DisplaySourceService",
            "    DisplayParams(selectedIndex=0, dispWidth=864, dispHeight=1920)",
            "     -- ProjectionWindowManager for display CarDisplayId{displayId=0}",
            "    Windows by layout z -- the order used for rendering:",
            *layers, "    Active windows by z -- order used for focus:",
            "    Windows by region:", "    Focusable windows: " + focus,
            *([f"    Current focus region: CarRegionId{{regionId=1}} {{name={current},region=R}}"] if current else []),
            "    Focus history: " + " ".join(history),
        ])

    def test_dashboard_visible_and_maps_touches_limited_by_focus_region(self):
        result = visible_panels(self.panels, self.report(self.map_layer, self.dashboard, self.rail,
            focus="(GmmCarProjectionService, Rect(0, 0 - 864, 1593))"))
        self.assertEqual([p["id"] for p in result], [4, 5, 6])
        self.assertEqual(result[0]["visibleRegions"], [[0, 0, 840, 1581]])

    def test_launcher_hides_dashboard_but_leaves_part_of_maps_on_screen(self):
        dump = self.report(self.map_layer, self.dashboard, self.launcher, self.rail,
                           focus="(GmmCarProjectionService, Rect(0, 0 - 864, 913))")
        result = visible_panels(self.panels, dump)
        self.assertEqual([p["id"] for p in result], [4, 5, 8])
        self.assertEqual(result[0]["visibleRegions"], [[0, 0, 840, 901]])

    def test_reports_the_focused_panel_instead_of_the_largest_or_highest(self):
        for current, expected in (("GmmCarProjectionService", 4), ("GhAppLauncherService", 8)):
            with self.subTest(current=current):
                report = self.report(self.map_layer, self.launcher, self.rail, current=current)
                self.assertEqual([p["id"] for p in visible_panels(self.panels, report) if p.get("appFocused")], [expected])

    def test_facet_bar_focus_reports_the_app_beneath_the_shell_widgets(self):
        report = self.report(self.map_layer, self.dashboard, self.rail, current=FACET_BAR, history=[FACET_BAR])

        self.assertEqual([p["id"] for p in visible_panels(self.panels, report) if p.get("appFocused")], [4])

    def test_launcher_overlay_has_priority_when_the_facet_bar_has_focus(self):
        report = self.report(self.map_layer, self.launcher, self.rail, current=FACET_BAR, history=[FACET_BAR])

        self.assertEqual([p["id"] for p in visible_panels(self.panels, report) if p.get("appFocused")], [8])

    def test_facet_bar_compares_exposed_car_area_across_different_android_display_scales(self):
        radio = "com.example.radio"
        panels = self.panels + projection_displays(
            logical_display(9, f"GhostActivityDisplay:ComponentInfo{{{radio}/.RadioCarService}}")
            + logical_display(10, radio + "/presentation", owner=radio, size="210 x 250")
        )
        radio_layer = render_window("RadioCarService", [12, 95, 852, 1095])
        report = self.report(self.map_layer, radio_layer, self.rail, current=FACET_BAR, history=[FACET_BAR])

        self.assertEqual([p["id"] for p in visible_panels(panels, report) if p.get("appFocused")], [10])

    def test_keyboard_and_tooltip_can_use_the_same_underlying_app_focus(self):
        panels = self.panels + projection_displays(logical_display(9, "TouchInputMethod") + logical_display(10, "Tooltip"))
        keyboard = render_window(TOUCH_IME, [12, 95, 852, 315], transparent=True)
        tooltip = render_window(GEARHEAD_TOOLTIP, [12, 95, 52, 145], transparent=True)
        history = ["GhAppLauncherService", "GmmCarProjectionService", TOUCH_IME]
        for current, order in ((TOUCH_IME, history), (GEARHEAD_TOOLTIP, [*history, GEARHEAD_TOOLTIP])):
            with self.subTest(current=current):
                report = self.report(self.map_layer, self.launcher, self.rail, keyboard, tooltip,
                                     current=current, history=order)
                self.assertEqual([p["id"] for p in visible_panels(panels, report) if p.get("appFocused")], [4])

    def test_unmapped_current_focus_and_mismatched_history_refuse_to_select_another_app(self):
        for current in ("UnmappedModal", TOUCH_IME):
            with self.subTest(current=current):
                report = self.report(self.map_layer, self.launcher, self.rail, current=current,
                                     history=["GmmCarProjectionService", "GhAppLauncherService"])
                self.assertFalse(any(p.get("appFocused") for p in visible_panels(self.panels, report)))

    def test_service_binds_the_launcher_when_there_is_no_ghost_activity_display(self):
        launcher = GEARHEAD + "/.system.applauncher.GhAppLauncherService"
        panels = projection_displays(logical_display(16, GEARHEAD + "/nfn", size="840 x 900")
                                     + logical_display(17, GEARHEAD + "/other", size="840 x 900"),
                                     include_unbound=True)
        report = self.report(self.launcher) + f"\nstartInfo=StartInfo{{componentName=ComponentInfo{{{launcher}}}, ghostActivity=null,"
        calls = []

        def describe_service(component):
            calls.append(component)
            return f"SERVICE {launcher} 1b41189 pid=13956 user=0\n    display:Display id 16:"

        result, = resolve_visible_panels(panels, report, describe_service)
        self.assertEqual((result["id"], result["carWindow"]), (16, "GhAppLauncherService"))
        self.assertEqual(calls, [GEARHEAD + "/" + GEARHEAD + ".system.applauncher.GhAppLauncherService"])

    def test_screen_to_panel_coordinates_and_letterbox_edges(self):
        panels = visible_panels(self.panels, self.report(self.map_layer, self.dashboard, self.launcher, self.rail,
            focus="(GmmCarProjectionService, Rect(0, 0 - 864, 913))"))
        maps, rail, launcher = panels
        self.assertEqual(launcher["screen"], {"width": 864, "height": 1920})
        self.assertEqual(launcher["carBounds"], [12, 925, 852, 1825])
        self.assertEqual(car_bounds(launcher, [0, 0, 100, 50]), [12, 925, 112, 975])
        self.assertEqual(hit_panel(panels, 72, 935), (launcher, 60, 10))
        self.assertEqual(hit_panel(panels, 12, 912), (maps, 0, 900))
        self.assertEqual(hit_panel(panels, 850, 1825), (rail, 850, 0))
        with self.assertRaisesRegex(ValueError, "no target"):
            hit_panel(panels, 4, 933)
        with self.assertRaisesRegex(ValueError, "outside"):
            hit_panel(panels, 864, 300)

    def test_translucent_unknown_overlay_keeps_view_visible_and_reserves_input(self):
        overlay = render_window("FloatingOverlay", [12, 95, 112, 195], transparent=True)
        panels = visible_panels(self.panels, self.report(self.launcher, overlay))
        self.assertEqual(panels[0]["visibleRegions"], [[0, 0, 840, 900]])
        with self.assertRaisesRegex(ValueError, "no target"):
            hit_panel(panels, 12, 1800)
        self.assertEqual(hit_panel(panels, 112, 1800), (panels[0], 100, 875))

    def test_scaled_panel_hit_uses_the_inverse_of_its_car_rectangle(self):
        panel = {**self.panels[-1], "width": 420, "height": 450}
        panels = visible_panels([panel], self.report(self.launcher))
        self.assertEqual(car_bounds(panels[0], [4, 5, 6, 7]), [20, 935, 24, 939])
        self.assertEqual(hit_panel(panels, 23, 938), (panels[0], 5, 6))

    def test_overlapping_foreign_window_and_ambiguous_app_surfaces(self):
        cover = render_window("UnmappedOverlay", [0, 0, 864, 1920])
        self.assertEqual(visible_panels(self.panels, self.report(self.launcher, cover)), [])
        same_size = {**self.panels[-1], "id": 9}
        with self.assertRaisesRegex(ValueError, "multiple Android displays"):
            visible_panels([*self.panels, same_size], self.report(self.launcher))
        with self.assertRaisesRegex(ValueError, "current car display layout"):
            visible_panels(self.panels, "Old events: Dashboard is showing")

    def test_app_services_with_identical_presentations_use_the_service_display(self):
        component = GEARHEAD + "/" + GEARHEAD + ".system.applauncher.GhAppLauncherService"
        first = {**self.panels[-1], "components": [component, f"{GEARHEAD}/{GEARHEAD}.MediaService"]}
        second = {**first, "id": 9}
        report = self.report(self.launcher)
        with self.assertRaisesRegex(ValueError, "Multiple app services"):
            visible_panels([first], report)
        with self.assertRaisesRegex(ValueError, "multiple Android displays"):
            visible_panels([first, second], report)
        def read_service(name):
            self.assertEqual(name, component)
            return (f"SERVICE {GEARHEAD}/.system.applauncher.GhAppLauncherService 3fa pid=42 user=0\n"
                    "  Client:\n    activity state:RESUMED\n    display:Display id 8: DisplayInfo{...}\n")
        self.assertEqual([p["id"] for p in resolve_visible_panels([first, second], report, read_service)], [8])

    def test_service_read_only_for_verified_ambiguity_and_only_once(self):
        report = self.report(self.launcher)
        result = resolve_visible_panels(self.panels, report, lambda _: self.fail("Unexpected service read"))
        self.assertEqual([p["id"] for p in result], [8])
        calls = []
        def unavailable(component):
            calls.append(component)
            return "No services match"
        with self.assertRaisesRegex(ValueError, "multiple Android displays"):
            resolve_visible_panels([*self.panels, {**self.panels[-1], "id": 11}], report, unavailable)
        self.assertEqual(calls, self.panels[-1]["components"])

    def test_ignores_inactive_panels_and_cached_display_info(self):
        dump = "".join([
            logical_display(1, "LayoutDisplay"),
            logical_display(2, "Dashboard", enabled=False),
            logical_display(3, "GhFacetBar", state="OFF"),
            logical_display(4, "Dashboard").replace("mBaseDisplayInfo=", "mOverrideDisplayInfo="),
            logical_display(5, "GhFacetBar", owner="com.google.android.projection.gearhead.demo"),
        ])
        self.assertEqual(projection_displays(dump), [])


if __name__ == "__main__":
    unittest.main()
