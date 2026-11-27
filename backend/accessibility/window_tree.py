"""Read one Android ViewHierarchyEncoder stream from dump-visible-window-views."""

from io import BytesIO
from struct import Struct


class HierarchyError(ValueError):
    """The window has no complete, decodable native view hierarchy."""


_PRIMITIVES = {key: Struct(">" + fmt) for key, fmt in {
    b"Z": "?", b"B": "b", b"S": "h", b"I": "i", b"J": "q", b"F": "f", b"D": "d",
}.items()}


class _Reader:
    def __init__(self, data):
        self.stream = BytesIO(data)

    def take(self, length):
        value = self.stream.read(length)
        if len(value) != length:
            raise HierarchyError("Incomplete window hierarchy")
        return value

    def key(self):
        if self.take(1) != b"S":
            raise HierarchyError("Expected a short property key")
        return _PRIMITIVES[b"S"].unpack(self.take(2))[0]

    def value(self, depth=0):
        tag = self.take(1)
        if tag in _PRIMITIVES:
            fmt = _PRIMITIVES[tag]
            return fmt.unpack(self.take(fmt.size))[0]
        if tag == b"R":
            length = _PRIMITIVES[b"S"].unpack(self.take(2))[0]
            if length < 0:
                raise HierarchyError("Invalid string length")
            # Android caps encoded strings at 32767 bytes, possibly splitting a UTF-8 character.
            return self.take(length).decode("utf-8", errors="replace")
        if tag == b"M":
            if depth > 200:
                raise HierarchyError("Window hierarchy exceeds the supported nesting depth")
            pairs = {}
            while (key := self.key()) != 0:
                pairs[key] = self.value(depth + 1)
            return pairs
        raise HierarchyError(f"Unknown property type {tag!r} at byte {self.stream.tell() - 1}")


def _resolve(properties, names):
    result = {}
    for key, value in properties.items():
        if key not in names:
            raise HierarchyError(f"Missing property name for key {key}")
        result[names[key]] = _resolve(value, names) if isinstance(value, dict) else value
    return result


def _children(properties):
    count = properties.pop("meta:__childCount__", 0)
    if type(count) is not int or count < 0 or count > len(properties):
        raise HierarchyError("Invalid view child count")
    children = []
    for index in range(count):
        child = properties.pop(f"meta:__child__{index}", None)
        if not isinstance(child, dict):
            raise HierarchyError(f"Missing view child {index}")
        children.append(_children(child))
    properties["children"] = children
    return properties


def decode_window(data: bytes) -> dict:
    """Return native property names and ordered children, including window offsets at the root."""
    reader = _Reader(data)
    offsets = {}
    while True:
        offset = reader.stream.tell()
        tag = reader.take(1)
        reader.stream.seek(offset)
        if tag == b"M":
            break
        key = reader.key()
        offsets[key] = reader.value()
    root = reader.value()
    names = reader.value()
    if not isinstance(root, dict) or not isinstance(names, dict) or reader.stream.read(1):
        raise HierarchyError("Expected a root view followed by its property index")
    if "__name__" not in names.values() or not all(isinstance(name, str) for name in names.values()):
        raise HierarchyError("Invalid window property index")
    return _children(_resolve({**offsets, **root}, names))
