import struct
import unittest

from accessibility.window_tree import HierarchyError, decode_window


def short(value):
    return b"S" + struct.pack(">h", value)


def string(text):
    data = text.encode("utf-8")
    return b"R" + struct.pack(">h", len(data)) + data


def mapping(*entries):
    return b"M" + b"".join(short(key) + value for key, value in entries) + short(0)


class WindowTreeTest(unittest.TestCase):
    def setUp(self):
        names = [
            "__name__", "window:top", "meta:__name__", "misc:clickable", "meta:__childCount__",
            "meta:__child__0", "layoutParams", "width",
        ]
        self.index = mapping((1, string("propertyIndex")),
                             *((i, string(name)) for i, name in enumerate(names, 1)))
        self.header = short(2) + b"I" + struct.pack(">i", -12)
        self.child = mapping((3, string("Button")), (4, b"Z\x01"))
        self.root = mapping((3, string("LínearLayout")), (5, short(1)), (6, self.child),
                            (7, mapping((8, short(-1)))))

    def test_nested_views_window_coordinates_and_layout_properties(self):
        fields = decode_window(self.header + self.root + self.index)
        self.assertEqual(fields, {
            "window:top": -12, "meta:__name__": "LínearLayout", "layoutParams": {"width": -1},
            "children": [{"meta:__name__": "Button", "misc:clickable": True, "children": []}],
        })

    def test_single_view_without_window_coordinates(self):
        self.assertEqual(decode_window(self.child + self.index)["children"], [])

    def test_invalid_streams(self):
        for invalid in [b"", self.root, self.root + self.index[:-1], self.root + self.index + b"B",
                        mapping((9, short(42))) + self.index, mapping((5, short(1))) + self.index,
                        mapping((3, b"R\xff\xff")) + self.index, b"MZ\x01",
                        mapping((3, b"X")) + self.index]:
            with self.subTest(data=invalid), self.assertRaises(HierarchyError):
                decode_window(invalid)


if __name__ == "__main__":
    unittest.main()
