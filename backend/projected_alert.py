"""Recognize projected Android dialogs without treating ordinary panels as alerts."""

import re


_PANEL = re.compile(r"(?:^|:)id/parentPanel$", re.I)
_TITLE = re.compile(r"(?:^|:)id/(?:alertTitle|permission_message)$", re.I)
_MESSAGE = re.compile(r"(?:^|:)id/message$", re.I)
_BUTTON = re.compile(r"(?:^|:)id/button[123]$", re.I)
_PERMISSION = re.compile(r"(?:^|:)id/permission_(?:allow|deny)", re.I)
_PLATFORM_BUTTON = re.compile(r"^android:id/button[123]$", re.I)
_PLATFORM_CONTENT = re.compile(r"^android:id/(?:alertTitle|message|buttonPanel|contentPanel)$", re.I)
PERMISSION_PACKAGES = {
    "com.android.permissioncontroller", "com.google.android.permissioncontroller",
    "com.android.packageinstaller", "com.google.android.packageinstaller",
}
_GRANT_SLOTS = [
    ("accept", r"allow_all"),
    ("accept", r"allow_foreground_only"),
    ("accept", r"allow(?:_all_time|_always)?"),
    ("accept", r"allow_selected"),
    ("accept", r"allow_one_time"),
    ("dismiss", r"deny"),
    ("dismiss", r"deny(?:_and)?_dont_ask_again"),
]
_ACCEPT = [r"allow while using (?:the )?app", r"while using the app", r"allow all", r"always allow",
           r"allow all the time", r"allow notifications", r"allow", r"ok", r"yes", r"continue",
           r"save", r"confirm.*", r"turn on", r"open settings", r"done", r"open", r"allow once", r"only this time"]
_DISMISS = [r"cancel", r"deny", r"don.?t allow", r"not now", r"no", r"dismiss", r"close",
            r"close app", r"later", r"skip", r"ask app not to track", r"keep browsing"]


def _id(node):
    return node.get("id") or ""


def _text(node):
    return (node.get("text") or node.get("description") or "").strip()


def _descends(node, root, nodes):
    visited = set()
    while node and node.get("ref") not in visited:
        if node.get("ref") == root.get("ref"):
            return True
        visited.add(node.get("ref"))
        node = nodes.get(node.get("parent"))
    return False


def observe_alert(tree):
    """Observe a single identifiable dialog in a projected snapshot."""
    nodes = tree.get("nodes", [])
    refs = {node.get("ref"): node for node in nodes if node.get("ref")}
    roots = []
    for node in nodes:
        name = (node.get("className") or "").rsplit(".", 1)[-1].rsplit("$", 1)[-1].lower()
        if name.endswith("dialog") or _PANEL.search(_id(node)):
            roots.append(node)
    # A class and its AlertController panel may describe the same dialog.
    roots = [root for root in roots if not any(root is not other and _descends(other, root, refs) for other in roots)]
    if len(roots) > 1:
        return {"kind": "undecided"}
    if roots:
        root = roots[0]
        package = root.get("packageName")
        group = [n for n in nodes if n.get("window") == root.get("window") and _descends(n, root, refs)]
    else:
        anchors = {(n.get("window"), n.get("packageName")) for n in nodes
                   if n.get("packageName") in PERMISSION_PACKAGES and _PERMISSION.search(_id(n))}
        if not anchors:
            buttons = {(n.get("window"), n.get("packageName")) for n in nodes if _PLATFORM_BUTTON.fullmatch(_id(n))}
            content = {(n.get("window"), n.get("packageName")) for n in nodes if _PLATFORM_CONTENT.fullmatch(_id(n))}
            anchors = buttons & content
        if len(anchors) != 1:
            suspicious = any(_BUTTON.search(_id(n)) or _PERMISSION.search(_id(n)) for n in nodes)
            return {"kind": "undecided" if suspicious else "none"}
        window, package = anchors.pop()
        group = [n for n in nodes if n.get("window") == window and n.get("packageName") == package]
    if not group:
        return {"kind": "undecided"}
    buttons = []
    for node in group:
        is_button = (node.get("className") or "").lower().endswith("button") or _BUTTON.search(_id(node)) or _PERMISSION.search(_id(node))
        label = _text(node)
        if is_button:
            if not label or not node.get("enabled") or "press" not in node.get("actions", []) or not node.get("ref"):
                return {"kind": "undecided"}
            buttons.append({"label": label, "ref": node["ref"], "id": _id(node)})
    titles = [_text(n) for n in group if _TITLE.search(_id(n)) and _text(n)]
    messages = [_text(n) for n in group if _MESSAGE.search(_id(n)) and _text(n)]
    if len(titles) > 1 or len(messages) > 1 or not buttons or len({b["ref"] for b in buttons}) != len(buttons):
        return {"kind": "undecided"}
    source = "permission" if package in PERMISSION_PACKAGES else "system-dialog" if package in {"android", "com.android.systemui"} else "native-dialog"
    alert = {"platform": "android", "source": source, "buttons": [button["label"] for button in buttons]}
    if package:
        alert["packageName"] = package
    if titles:
        alert["title"] = titles[0]
    if messages:
        alert["message"] = messages[0]
    return {"kind": "alert", "candidate": {"alert": alert, "buttons": buttons}}


def choose_alert(candidate, action):
    """Choose one role-labelled button, refusing ambiguous or unknown choices."""
    if action not in ("accept", "dismiss"):
        raise ValueError("Expected accept or dismiss.")
    buttons = candidate.get("buttons", [])
    permission = candidate.get("alert", {}).get("packageName") in PERMISSION_PACKAGES
    ranked = []
    neutral = []
    for button in buttons:
        identifier = button.get("id", "")
        label = button.get("label", "").strip()
        if _PERMISSION.search(identifier):
            grant = next(((role, index) for index, (role, suffix) in enumerate(_GRANT_SLOTS)
                          if re.search(rf"(?:^|:)id/permission_{suffix}(?:_button)?$", identifier, re.I)), None)
            if not permission or grant is None:
                return None
            if grant[0] == action:
                ranked.append((grant[1], button))
            continue
        role = re.search(r"(?:^|:)id/button([123])$", identifier, re.I)
        if role:
            preferred = {"1": "accept", "2": "dismiss", "3": "neutral"}[role[1]]
            if preferred == action:
                ranked.append((len(_GRANT_SLOTS), button))
            elif preferred == "neutral":
                neutral.append(button)
            continue
        match = next(((kind, index) for kind, preferences in (("accept", _ACCEPT), ("dismiss", _DISMISS))
                      for index, pattern in enumerate(preferences) if re.fullmatch(pattern, label, re.I)), None)
        if match is None:
            neutral.append(button)
        elif match[0] == action:
            ranked.append((len(_GRANT_SLOTS) + 1 + match[1], button))
    ranked.sort(key=lambda item: item[0])
    choice = None
    if ranked and (len(ranked) == 1 or ranked[0][0] != ranked[1][0]):
        choice = ranked[0][1]
    elif action == "dismiss" and neutral:
        choice = neutral[0]
    elif action == "accept" and len(buttons) == 1:
        choice = buttons[0]
    return {"label": choice["label"], "ref": choice["ref"]} if choice else None
