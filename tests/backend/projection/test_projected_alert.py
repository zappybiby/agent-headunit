import unittest

from projection.alerts import choose_alert, observe_alert


def node(ref, parent=None, **fields):
    return {"ref": ref, "parent": parent, "window": "car", "packageName": "example.app",
            "className": "android.view.View", "id": "", "text": "", "enabled": True,
            "actions": [], **fields}


def dialog():
    return {"nodes": [
        node("root", className="android.widget.FrameLayout", id="id/parentPanel"),
        node("title", "root", id="id/alertTitle", text="Remove item?"),
        node("message", "root", id="android:id/message", text="This removes it."),
        node("yes", "root", id="android:id/button1", className="android.widget.Button", text="Confirm", actions=["press"]),
        node("no", "root", id="android:id/button2", className="android.widget.Button", text="Cancel", actions=["press"]),
    ]}


class ProjectedAlertTest(unittest.TestCase):
    def test_dialog_and_role_choices(self):
        result = observe_alert(dialog())
        self.assertEqual(result["kind"], "alert")
        candidate = result["candidate"]
        self.assertEqual(candidate["alert"], {"platform": "android", "source": "native-dialog",
                         "packageName": "example.app", "title": "Remove item?",
                         "message": "This removes it.", "buttons": ["Confirm", "Cancel"]})
        self.assertEqual(choose_alert(candidate, "accept"), {"label": "Confirm", "ref": "yes"})
        self.assertEqual(choose_alert(candidate, "dismiss"), {"label": "Cancel", "ref": "no"})

    def test_ordinary_panel_and_unresolved_shapes(self):
        self.assertEqual(observe_alert({"nodes": [node("normal", text="Continue", actions=["press"])]}), {"kind": "none"})
        self.assertEqual(observe_alert({"nodes": [node("button", id="android:id/button1")]}), {"kind": "undecided"})
        tree = dialog()
        tree["nodes"][-1]["enabled"] = False
        self.assertEqual(observe_alert(tree), {"kind": "undecided"})

    def test_ambiguous_or_unknown_choices_never_dispatch(self):
        tree = dialog()
        tree["nodes"][-2]["id"] = ""
        tree["nodes"][-1]["id"] = ""
        tree["nodes"][-1]["text"] = "Confirm"
        candidate = observe_alert(tree)["candidate"]
        self.assertIsNone(choose_alert(candidate, "accept"))
        candidate["buttons"][0]["id"] = "id/permission_allow_new_button"
        self.assertIsNone(choose_alert(candidate, "accept"))

    def test_permission_choices_use_controller_ids_without_a_dialog_container(self):
        pkg = "com.google.android.permissioncontroller"
        tree = {"nodes": [
            node("title", packageName=pkg, id=f"{pkg}:id/permission_message", text="Camera"),
            node("temporary", packageName=pkg, id=f"{pkg}:id/permission_allow_one_time_button",
                 text="Solo questa volta", actions=["press"]),
            node("foreground", packageName=pkg, id=f"{pkg}:id/permission_allow_foreground_only_button",
                 text="Durante l'uso", actions=["press"]),
            node("deny", packageName=pkg, id=f"{pkg}:id/permission_deny_button",
                 text="Non consentire", actions=["press"]),
        ]}
        candidate = observe_alert(tree)["candidate"]
        self.assertEqual(candidate["alert"]["source"], "permission")
        self.assertEqual(choose_alert(candidate, "accept")["ref"], "foreground")
        self.assertEqual(choose_alert(candidate, "dismiss")["ref"], "deny")

    def test_platform_content_and_buttons_identify_a_dialog_without_parent_panel(self):
        tree = dialog()
        tree["nodes"][0]["id"] = ""
        tree["nodes"][1]["id"] = "android:id/alertTitle"
        candidate = observe_alert(tree)["candidate"]
        self.assertEqual(candidate["alert"]["title"], "Remove item?")
        self.assertEqual(choose_alert(candidate, "accept")["ref"], "yes")
        tree["nodes"][-1]["window"] = "another-window"
        tree["nodes"][-2]["window"] = "another-window"
        self.assertEqual(observe_alert(tree), {"kind": "undecided"})


if __name__ == "__main__":
    unittest.main()
