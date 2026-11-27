"""Inspect and operate the active Android Auto projection through its UI tree."""

import argparse
import json
import math
import sys
import time

from projection.connection import Connection, HeadunitError


def matches(nodes, selector):
    """Match references, exact labels, or exact Android resource identifiers."""
    if not selector:
        raise HeadunitError("Enter a node reference, label, or resource ID.")
    field, sep, value = selector.partition("=")
    if sep and field in {"text", "desc", "id", "ref", "class"}:
        fields = [{"desc": "description", "class": "className"}.get(field, field)]
    else:
        fields = ["ref", "text", "description", "id"]
        value = selector
    if not value:
        raise HeadunitError("The selector value is empty.")
    result = []
    for node in nodes:
        if any(node.get(key) == value for key in fields):
            result.append(node)
        elif "id" in fields and (node.get("id") or "").rsplit("/", 1)[-1] == value:
            result.append(node)
        elif "className" in fields and node["className"].rsplit(".", 1)[-1] == value:
            result.append(node)
    return result


def describe(node):
    values = [node["ref"], node["className"].rsplit(".", 1)[-1]]
    for key in ("text", "description", "id"):
        if node.get(key) and (key != "description" or node[key] != node.get("text")):
            values.append(json.dumps(node[key], ensure_ascii=False))
    if node.get("actions"):
        values.append("[" + ", ".join(node["actions"]) + "]")
    for flag in ("selected", "checked", "focused"):
        if node.get(flag):
            values.append(flag)
    if node.get("enabled") is False:
        values.append("disabled")
    return " ".join(values)


def unique(nodes, selector):
    found = matches(nodes, selector)
    if len(found) == 1:
        return found[0]
    if not found:
        raise HeadunitError(f"No visible element matches {selector!r}.")
    options = "\n".join(describe(node) for node in found)
    raise HeadunitError(f"{selector!r} matches {len(found)} elements. Select a reference.\n{options}")


class Headunit:
    """A connection to one phone and projection display."""

    def __init__(self, serial=None, display=None):
        self.connection = Connection.connect(serial, display)

    def snapshot(self):
        return self.connection.request("snapshot")

    def find(self, selector):
        return matches(self.snapshot()["nodes"], selector)

    def wait(self, selector, timeout=10.0, gone=False):
        if timeout < 0 or not math.isfinite(timeout):
            raise HeadunitError("Timeout must be a finite number of seconds of zero or more.")
        deadline = time.monotonic() + timeout
        while True:
            found = self.find(selector)
            if bool(found) != gone:
                return found
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                state = "disappear" if gone else "appear"
                raise HeadunitError(f"Timed out waiting for {selector!r} to {state}.")
            time.sleep(min(0.25, remaining))

    def _act(self, selector, action, op, *, observed=None, **params):
        tree = (observed if observed is not None else self.snapshot())["nodes"]
        hit = node = unique(tree, selector)
        by_ref = {item["ref"]: item for item in tree}
        while node is not None:
            if node.get("enabled") is False:
                raise HeadunitError(f"{selector!r} is disabled.")
            if action in node["actions"]:
                if observed is not None and node.get("rendererTarget"):
                    params["observed"] = observed
                return self.connection.request(op, target=node["ref"], hit=hit["ref"], **params)
            node = by_ref.get(node.get("parent"))
        raise HeadunitError(f"{selector!r} has no enclosing control that supports {action}.")

    def press(self, selector, *, observed=None):
        return self._act(selector, "press", "press", observed=observed)

    def scroll(self, selector, direction):
        if direction not in {"forward", "backward"}:
            raise HeadunitError("Scroll direction must be forward or backward.")
        return self._act(selector, "scroll-" + direction, "scroll", direction=direction)

def snapshot_lines(tree, interactive=False):
    panels = {p["id"]: p["name"] for p in tree["displays"]}
    yield f"{tree['serial']}  |  {len(tree['nodes'])} visible nodes"
    previous = None
    depths = {}
    for node in tree["nodes"]:
        if node["window"] != previous:
            yield f"\n{panels[node['display']]}  |  display {node['display']}"
            previous = node["window"]
        depth = depths.get(node.get("parent"), 0)
        show = (node["actions"] if interactive else
                any(node.get(key) for key in ("text", "description", "actions", "id")))
        depths[node["ref"]] = depth + bool(show)
        if show:
            yield "  " * depth + describe(node)


def parser():
    p = argparse.ArgumentParser(description=__doc__, epilog=(
        "Use a snapshot reference, exact label, id=, class=, text=, desc= or ref=. "
        "Android production window dumps generally expose resource IDs and omit displayed text. "
        "Use --serial and --display before the command to select a phone or panel."
    ))
    p.add_argument("--serial", help="ADB serial of the projecting phone")
    p.add_argument("--display", type=int, help="phone projection display ID")
    p.add_argument("--json", action="store_true", help="emit machine readable results")
    commands = p.add_subparsers(dest="op", required=True)
    mirror = commands.add_parser("mirror", help="publish native accessibility nodes to the debug receiver")
    mirror.add_argument("--receiver", required=True, help="ADB serial of the receiver")
    commands.add_parser("displays", help="list active projection displays on connected phones")
    snap = commands.add_parser("snapshot", help="read the projected UI tree")
    snap.add_argument("-i", "--interactive", action="store_true", help="show only actionable controls")
    for name, help_text in (("find", "list matching elements"), ("press", "activate an element"),
                            ("scroll", "scroll an element"),
                            ("wait", "wait for an element to appear or disappear")):
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument("selector")
        if name == "scroll":
            sub.add_argument("direction", choices=("forward", "backward"))
        if name == "wait":
            sub.add_argument("--timeout", type=float, default=10, metavar="SECONDS")
            sub.add_argument("--gone", action="store_true")
    return p


def main():
    args = parser().parse_args()
    try:
        if args.op == "mirror":
            from accessibility.mirror import run
            run(args.serial, args.receiver)
            return 0
        if args.op == "displays":
            result = Connection.displays(args.serial)
            lines = [f"{d['serial']}  display {d['id']}  {d['name']}" for d in result]
            if not lines:
                lines.append("No active Android Auto projection. Connect the receiver to the phone.")
        else:
            unit = Headunit(args.serial, args.display)
            if args.op == "snapshot":
                result = unit.snapshot()
                lines = snapshot_lines(result, args.interactive)
                if args.json and args.interactive:
                    result = {**result, "nodes": [node for node in result["nodes"] if node["actions"]]}
            elif args.op in {"find", "wait"}:
                result = (unit.find(args.selector) if args.op == "find" else
                          unit.wait(args.selector, args.timeout, args.gone))
                lines = [describe(node) for node in result] or ["No matching elements."]
            else:
                if args.op == "press":
                    result = unit.press(args.selector)
                else:
                    result = unit.scroll(args.selector, args.direction)
                lines = ["OK"]
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print("\n".join(lines))
        return 0
    except HeadunitError as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        else:
            print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if sys.argv[1:] == ["rpc"]:
        from rpc import main as rpc_main
        raise SystemExit(rpc_main())
    if sys.argv[1:] == ["rpc-worker"]:
        from rpc import worker
        raise SystemExit(worker())
    raise SystemExit(main())
