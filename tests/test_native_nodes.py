import copy
import unittest

from native_nodes import window_nodes


def view(name, x, y, width, height, *children, **properties):
    return {
        "id": "id/" + name, "meta:__name__": "android.view.View", "meta:__hash__": len(name),
        "layout:left": x, "layout:top": y, "layout:width": width, "layout:height": height,
        "children": children, **properties,
    }


class NativeNodesTest(unittest.TestCase):
    def setUp(self):
        self.panel = {"serial": "phone", "id": 4, "uniqueId": "projection", "width": 100,
                      "height": 100, "owner": "app"}
        self.window = "abc Window"

    def nodes(self, root):
        return {n["id"]: n for n in window_nodes(root, self.panel, self.window)}

    def test_geometry_visibility_and_state(self):
        flags = {"misc:clickable": True, "drawing:translationX": 2, "focus:isFocused": True}
        child = view("button", 7, 1, 20, 20, **flags)
        hidden = view("hidden", 0, 0, 8, 8, **{"drawing:alpha": 0})
        gone = view("gone", 0, 0, 8, 8, **{"misc:visibility": 8})
        root = view("root", 0, 0, 70, 70, child, hidden, gone,
                    **{"window:left": 10, "window:top": 3, "scrolling:scrollX": 4,
                       "drawing:clipToPadding": True, "padding:paddingTop": 4,
                       "misc:transformation.alpha": 0})
        nodes = self.nodes(root)
        self.assertEqual(set(nodes), {"id/root", "id/button"})
        button = nodes["id/button"]
        self.assertEqual(button["bounds"], [15, 7, 35, 24])
        self.assertEqual(button["parent"], nodes["id/root"]["ref"])
        self.assertTrue(button["focused"])
        self.assertEqual(button["actions"], ["press"])

    def test_scale_clip_and_disabled_controls(self):
        child = view("image", 0, 0, 60, 20, **{
            "drawing:scaleX": 0.5, "drawing:clipBounds": "Rect(0, 2 - 20, 30)",
            "misc:clickable": True, "misc:enabled": False})
        node = self.nodes(child)["id/image"]
        self.assertEqual(node["bounds"], [15, 2, 25, 20])
        self.assertFalse(node["enabled"])
        self.assertEqual(node["actions"], [])

    def test_disjoint_panel_regions_and_clickable_descendants(self):
        self.panel["visibleRegions"] = [[0, 0, 35, 100], [70, 0, 100, 100]]
        child = view("button", 70, 25, 15, 50, **{"misc:clickable": True})
        parent = view("row", 0, 0, 100, 100, child, **{"misc:clickable": True})
        nodes = self.nodes(parent)
        self.assertEqual(nodes["id/row"]["bounds"], [0, 0, 35, 100])
        self.assertEqual(nodes["id/button"]["pressBounds"], [70, 25, 85, 75])
        for left, top, right, bottom in nodes["id/row"]["pressRegions"]:
            self.assertTrue(right <= 70 or left >= 85 or bottom <= 25 or top >= 75)
        self.panel["visibleRegions"] = []
        self.assertEqual(self.nodes(parent), {})

    def test_full_size_focus_wrapper_leaves_only_the_real_button_pressable(self):
        child = view("button", 0, 0, 80, 80, **{"misc:clickable": True})
        parent = view("wrapper", 0, 0, 80, 80, child, **{"misc:clickable": True})
        nodes = self.nodes(parent)
        self.assertEqual(nodes["id/wrapper"]["actions"], [])
        self.assertIsNone(nodes["id/wrapper"]["pressBounds"])
        self.assertEqual(nodes["id/button"]["actions"], ["press"])

    def test_translucent_overlay_and_scroll_target_regions(self):
        self.panel["hitRegions"] = [[0, 70, 100, 100]]
        scroller = view("list", 0, 0, 100, 100,
            view("hiddenInput", 0, 0, 25, 20, **{"misc:clickable": True}),
            **{"meta:__name__": "androidx.recyclerview.widget.RecyclerView", "misc:clickable": True})
        nodes = self.nodes(scroller)
        self.assertEqual(nodes["id/list"]["bounds"], [0, 0, 100, 100])
        self.assertEqual(nodes["id/list"]["scrollBounds"], [0, 70, 100, 100])
        self.assertEqual(nodes["id/list"]["pressBounds"], [0, 70, 100, 100])
        self.assertEqual(nodes["id/hiddenInput"]["actions"], [])
        self.panel["hitRegions"] = []
        self.assertEqual(self.nodes(scroller)["id/list"]["actions"], [])

    def test_label_and_input_state_are_preserved_in_the_snapshot(self):
        text = view("field", 0, 0, 15, 10, **{
            "text:text": "Music", "accessibility:contentDescription": "Choose media",
            "text:editable": True, "focus:isFocusable": True, "misc:longClickable": True,
            "text:checked": False})
        node = self.nodes(text)["id/field"]
        self.assertEqual((node["text"], node["description"]), ("Music", "Choose media"))
        self.assertTrue(node["editable"] and node["focusable"] and node["longClickable"] and node["checkable"])
        self.assertFalse(node["checked"])

    def test_refs_change_on_row_rebind_or_session_change(self):
        title = view("title", 0, 0, 20, 20, **{"text:text": "First"})
        icon = view("icon", 20, 0, 20, 20)
        row = view("row", 0, 0, 80, 20, title, icon, **{"misc:clickable": True})
        original = self.nodes(row)
        self.assertEqual(original, self.nodes(copy.deepcopy(row)))
        title["text:text"] = "Next"
        rebound = self.nodes(row)
        for key in original:
            self.assertNotEqual(original[key]["ref"], rebound[key]["ref"])
        self.panel["serial"] = "another"
        self.assertNotEqual(rebound["id/row"]["ref"], self.nodes(row)["id/row"]["ref"])

    def test_named_renderer_control_retains_touch_identity_when_separate_views_redraw(self):
        caption = view("caption", 5, 0, 20, 20, **{"text:text": "Start"})
        decoration = view("spinner", 0, 0, 5, 5)
        button = view("button", 0, 0, 25, 20, caption, decoration, **{
            "misc:clickable": True, "rendererTarget": {"windowId": 42}, "meta:__hash__": "android-node",
            "accessibility:row": {"scrollable": False, "hint": "", "showingHint": False, "password": False}})
        sibling = view("status", 40, 0, 35, 20, **{"text:text": "Waiting", "misc:clickable": True})
        title = view("rowTitle", 0, 25, 35, 15, **{"text:text": "First row"})
        root = view("root", 0, 0, 90, 40, button, sibling, title, **{"misc:clickable": True})
        first = self.nodes(root)["id/button"]

        sibling["text:text"] = "Ready"
        decoration["layout:left"] = 1
        after_redraw = self.nodes(root)["id/button"]
        self.assertNotEqual(first["ref"], after_redraw["ref"])
        self.assertEqual(first["pressId"], after_redraw["pressId"])

        title["text:text"] = "Reused for another row"
        self.assertNotEqual(first["pressId"], self.nodes(root)["id/button"]["pressId"])
        title["text:text"] = "First row"
        caption["text:text"] = "Cancel"
        self.assertNotEqual(first["pressId"], self.nodes(root)["id/button"]["pressId"])
        button["misc:enabled"] = False
        self.assertNotIn("pressId", self.nodes(root)["id/button"])


if __name__ == "__main__":
    unittest.main()
