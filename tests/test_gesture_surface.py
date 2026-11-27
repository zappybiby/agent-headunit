import unittest

from gesture_surface import display_gesture
from transport import HeadunitError


def panel(identifier, bounds, size, regions, z):
    return {"id": identifier, "carBounds": bounds, "width": size[0], "height": size[1],
            "hitRegions": regions, "z": z, "screen": {"width": 140, "height": 100}}


APP = panel(7, [10, 10, 110, 110], (50, 50), [[0, 0, 30, 50], [45, 0, 50, 50]], 0)
OVERLAY = panel(8, [70, 20, 100, 80], (30, 60), [[0, 0, 30, 60]], 1)


def frames(*events):
    return [{"atMs": index * 20, "events": [{"id": pointer, "phase": phase, "x": x, "y": y}]}
            for index, (pointer, phase, x, y) in enumerate(events)]


class GestureSurfaceTest(unittest.TestCase):
    def test_existing_contact_keeps_app_display_under_an_overlay(self):
        drag = frames(("one", "down", 30, 50), ("one", "move", 80, 50), ("one", "up", 94, 60))
        for panels in ([APP, OVERLAY], [APP]):
            with self.subTest(mapped_overlay=len(panels) == 2):
                plan = display_gesture(panels, drag)
                self.assertEqual(plan["displayId"], 7)
                self.assertEqual([frame["events"][0] for frame in plan["frames"]], [
                    {"id": 0, "phase": "down", "x": 10, "y": 20},
                    {"id": 0, "phase": "move", "x": 35, "y": 20},
                    {"id": 0, "phase": "up", "x": 42, "y": 25},
                ])

    def test_new_contact_uses_the_top_panel_and_cannot_join_from_another_display(self):
        tap = frames(("one", "down", 80, 40), ("one", "up", 80, 40))
        self.assertEqual(display_gesture([APP, OVERLAY], tap)["displayId"], 8)
        with self.assertRaisesRegex(ValueError, "no target"):
            display_gesture([APP], tap)
        pinch = frames(("one", "down", 30, 50), ("two", "down", 80, 50),
                       ("two", "up", 80, 50), ("one", "up", 30, 50))
        with self.assertRaisesRegex(HeadunitError, "new pointer landed on another"):
            display_gesture([APP, OVERLAY], pinch)

    def test_path_stays_inside_the_original_panel_and_visible_screen(self):
        for x, y in ((110, 60), (30, 100)):
            with self.subTest(x=x, y=y), self.assertRaisesRegex(HeadunitError, "original projected panel bounds"):
                display_gesture([APP, OVERLAY], frames(("one", "down", 30, 50), ("one", "up", x, y)))
