"""Map Android native view properties to controls on one projection panel."""

import hashlib
import json
import math
import re


def _intersect(a, b):
    return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))


def _area(rect):
    return max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])


def _subtract(regions, cover):
    result = []
    for left, top, right, bottom in regions:
        x1, y1, x2, y2 = _intersect((left, top, right, bottom), cover)
        if x1 >= x2 or y1 >= y2:
            result.append([left, top, right, bottom])
            continue
        for piece in ([left, top, right, y1], [left, y2, right, bottom],
                      [left, y1, x1, y2], [x2, y1, right, y2]):
            if _area(piece):
                result.append(piece)
    return result


def _map_rect(frame, left, top, right, bottom):
    x, y, scale_x, scale_y = frame
    x1, x2 = sorted((x + scale_x * left, x + scale_x * right))
    y1, y2 = sorted((y + scale_y * top, y + scale_y * bottom))
    return x1, y1, x2, y2


def _frame(view, parent_frame, width, height):
    x, y, parent_x, parent_y = parent_frame
    scale_x, scale_y = view.get("drawing:scaleX", 1), view.get("drawing:scaleY", 1)
    left = view.get("layout:left", 0) + view.get("drawing:translationX", 0)
    top = view.get("layout:top", 0) + view.get("drawing:translationY", 0)
    left += view.get("drawing:pivotX", width / 2) * (1 - scale_x)
    top += view.get("drawing:pivotY", height / 2) * (1 - scale_y)
    return x + parent_x * left, y + parent_y * top, parent_x * scale_x, parent_y * scale_y


def _scroll_axis(view, class_name):
    # The encoded hierarchy has scroll offsets and widget classes, but no canScrollVertically().
    if class_name.endswith(("HorizontalScrollView", "ViewPager")) or view.get("scrolling:scrollX"):
        return "horizontal"
    if class_name.endswith(("ScrollView", "RecyclerView", "ListView", "GridView")) or view.get("scrolling:scrollY"):
        return "vertical"
    return None


def window_nodes(root: dict, panel: dict, window_key: str) -> list[dict]:
    """Return visible controls in parent-first order, with bounds in panel pixels."""
    nodes = []
    parents = []
    press_contexts = []
    scope = [panel["serial"], panel["id"], panel.get("uniqueId"), window_key]
    viewport = (0, 0, panel["width"], panel["height"])
    visible_regions = panel.get("visibleRegions", [viewport])
    hit_regions = panel.get("hitRegions", visible_regions)

    def clip_regions(bounds, clips):
        regions = [[math.ceil(edge) for edge in _intersect(bounds, rect)] for rect in clips]
        return [rect for rect in regions if _area(rect)]

    def visit(view, path, parent_index, parent_frame, clip, clickable_parent):
        if (view.get("misc:visibility", 0) != 0 or view.get("drawing:alpha", 1) <= 0
                or view.get("drawing:transitionAlpha", 1) <= 0):
            return None
        # A rotated view needs a polygon hit test. Wait until it settles before offering a target.
        if any(view.get(key, 0) % 360 for key in ("drawing:rotation", "drawing:rotationX", "drawing:rotationY")):
            return None
        width, height = view.get("layout:width", 0), view.get("layout:height", 0)
        if width <= 0 or height <= 0:
            return None
        frame = _frame(view, parent_frame, width, height)
        bounds = _intersect(clip, _map_rect(frame, 0, 0, width, height))
        clipping = view.get("drawing:clipBounds")
        if clipping:
            match = re.fullmatch(r"Rect\((-?\d+), (-?\d+) - (-?\d+), (-?\d+)\)", clipping)
            if not match:
                return None
            bounds = _intersect(bounds, _map_rect(frame, *map(int, match.groups())))
        # Touch dispatch checks the point against each enclosing view, even with clipChildren off.
        regions = clip_regions(bounds, visible_regions)
        if not regions:
            return None
        pixels = max(regions, key=_area)

        class_name = view.get("meta:__name__", "")
        resource = view.get("id", "")
        enabled = view.get("misc:enabled", True)
        semantic = view.get("accessibility:row")
        axis = _scroll_axis(view, class_name)
        if semantic is not None:
            known_axis = semantic.get("scrollAxis", axis)
            axis = (known_axis or "vertical") if semantic["scrollable"] else None
        actions = []
        clickable = view.get("misc:clickable", False)
        long_clickable = view.get("misc:longClickable")
        hit = clip_regions(bounds, hit_regions)
        if enabled and clickable and hit:
            actions.append("press")
        if enabled and axis and hit:
            for name, mask in (("scroll-forward", 4096), ("scroll-backward", 8192)):
                if semantic is None or semantic["actions"] & mask:
                    actions.append(name)
        index = len(nodes)
        node = {
            "display": panel["id"], "window": window_key, "packageName": panel["owner"],
            "className": class_name, "id": "" if resource == "NO_ID" else resource,
            "text": view.get("text:text", ""), "description": view.get("accessibility:contentDescription", ""),
            "actions": actions, "bounds": pixels, "visible": True, "enabled": enabled,
            "focused": view.get("focus:isFocused", False), "selected": view.get("misc:selected", False),
            "focusable": view.get("focus:isFocusable", False),
            "editable": view.get("text:editable", class_name.endswith(("EditText", "AutoCompleteTextView"))),
        }
        if "text:checked" in view:
            node["checkable"] = True
            node["checked"] = view["text:checked"]
        if type(view.get("misc:clickable")) is bool:
            node["clickable"] = clickable
        if semantic is not None:
            node.update(hint=semantic["hint"], showingHint=semantic["showingHint"], password=semantic["password"])
            if "reader" in semantic:
                node["readerClickable"] = clickable
            if view.get("rendererTarget"):
                node["rendererTarget"] = view["rendererTarget"]
            if view.get("fieldId"):
                node["fieldId"] = view["fieldId"]
            for key in ("roleDescription", "heading", "stateDescription", "tooltip", "clickLabel", "selectionStart", "selectionEnd",
                        "hiddenContentAbove", "hiddenContentBelow", "iconResource", "imageItemTitle", "reader"):
                if key in semantic:
                    node[key] = semantic[key]
            if known_axis == "vertical" and not ("hiddenContentAbove" in node or "hiddenContentBelow" in node):
                if "scroll-backward" in actions:
                    node["hiddenContentAbove"] = True
                if "scroll-forward" in actions:
                    node["hiddenContentBelow"] = True
            if axis and semantic.get("scrollAxis"):
                node["reportedScrollAxis"] = semantic["scrollAxis"]
        if long_clickable is not None:
            node["longClickable"] = long_clickable
        if axis:
            node["scrollAxis"] = axis
            if hit:
                i = 0 if axis == "horizontal" else 1
                node["scrollBounds"] = max(hit, key=lambda r: (r[i + 2] - r[i], _area(r)))
        if clickable or long_clickable:
            if clickable_parent is not None:
                enclosing = nodes[clickable_parent]
                for region in hit:
                    enclosing["pressRegions"] = _subtract(enclosing["pressRegions"], region)
            node["pressRegions"] = hit
            clickable_parent = index
        nodes.append(node)
        parents.append(parent_index)
        press_contexts.append(None)

        child_clip = bounds
        if view.get("drawing:clipToPadding", False):
            pad = _map_rect(frame, view.get("padding:paddingLeft", 0), view.get("padding:paddingTop", 0),
                            width - view.get("padding:paddingRight", 0), height - view.get("padding:paddingBottom", 0))
            child_clip = _intersect(child_clip, pad)
        x, y, scale_x, scale_y = frame
        child_frame = (x - scale_x * view.get("scrolling:scrollX", 0),
                       y - scale_y * view.get("scrolling:scrollY", 0), scale_x, scale_y)
        children = []
        captions = {value for key in ("text", "description", "tooltip", "clickLabel")
                    if (value := node.get(key))}
        for i, child in enumerate(view.get("children", [])):
            result = visit(child, (*path, i), index, child_frame, child_clip, clickable_parent)
            if result:
                child_ref, child_captions = result
                children.append(child_ref)
                captions.update(child_captions)

        source_id = view.get("meta:__hash__")
        identity = [scope, path, source_id, class_name, resource, node["text"],
                    node["description"], node.get("tooltip"), node.get("clickLabel"), pixels, children]
        if node.get("iconResource"):
            identity.append(node["iconResource"])
            captions.add(node["iconResource"])
        if node.get("imageItemTitle"):
            identity.append(["imageItemTitle", node["imageItemTitle"]])
        data = json.dumps(identity, ensure_ascii=True, separators=(",", ":")).encode()
        node["ref"] = "@e" + hashlib.blake2s(data, digest_size=8).hexdigest()
        renderer = node.get("rendererTarget")
        # A touch stays on the same Android control when decoration elsewhere redraws.
        if (renderer and source_id and "press" in actions and not node["editable"]
                and any(caption.strip().lower() not in ("", "image") for caption in captions)):
            press_identity = [scope, renderer["windowId"], source_id, class_name, resource,
                              node["text"], node["description"], node.get("tooltip"), node.get("clickLabel"),
                              node["selected"], node.get("checked"), sorted(captions)]
            data = json.dumps(press_identity, ensure_ascii=True, separators=(",", ":")).encode()
            node["pressId"] = hashlib.blake2s(data, digest_size=16).hexdigest()
        list_item = (node.get("roleDescription") or "").lower() == "list item"
        if clickable or long_clickable or list_item:
            press_contexts[index] = [source_id, class_name, resource, sorted(captions)]
        owns_action = clickable or long_clickable or axis or node["editable"] or node.get("checkable") or list_item
        return node["ref"], set() if owns_action else captions

    visit(root, (), None, (root.get("window:left", 0), root.get("window:top", 0), 1, 1), viewport, None)
    contexts = []
    enclosing_press_contexts = []
    for node, parent in zip(nodes, parents):
        context = None
        press_context = None
        if parent is not None:
            enclosing = nodes[parent]
            context = enclosing["ref"] if "pressRegions" in enclosing else contexts[parent]
            if context:
                node["ref"] = "@e" + hashlib.blake2s(
                    (context + node["ref"]).encode(), digest_size=8).hexdigest()
            press_context = press_contexts[parent] or enclosing_press_contexts[parent]
            if node.get("pressId") and press_context:
                data = json.dumps([node["pressId"], press_context], ensure_ascii=True, separators=(",", ":")).encode()
                node["pressId"] = hashlib.blake2s(data, digest_size=16).hexdigest()
        contexts.append(context)
        enclosing_press_contexts.append(press_context)
        node["parent"] = None if parent is None else nodes[parent]["ref"]
        if "pressRegions" in node:
            node["pressBounds"] = max(node["pressRegions"], key=_area, default=None)
            if node["pressBounds"] is None and "press" in node["actions"]:
                node["actions"].remove("press")
                node.pop("pressId", None)
    return nodes
