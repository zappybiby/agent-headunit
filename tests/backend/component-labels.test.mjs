import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("uses Android service, application, and activity labels for launcher entries", async () => {
  const source = await readFile(new URL("../../backend/frida/component-labels.js", import.meta.url), "utf8");
  const services = new Map([
    ["test.music/.Browser", {
      labelRes: { value: 0 },
      nonLocalizedLabel: { value: null },
      applicationInfo: { value: { label: "Music" } },
      loadLabel: () => ".Browser",
    }],
    ["test.books/.Browser", {
      labelRes: { value: 1 },
      nonLocalizedLabel: { value: null },
      applicationInfo: { value: { label: "Books" } },
      loadLabel: () => "Audiobooks",
    }],
  ]);
  const packageManager = {
    getServiceInfo: (component) => services.get(component),
    getApplicationLabel: (application) => application.label,
    getActivityInfo: (component) => component === "test.maps/.Activity" ? {
      labelRes: { value: 0 },
      nonLocalizedLabel: { value: null },
      loadLabel: () => "Maps",
    } : undefined,
  };
  const application = {
    getPackageName: () => "com.google.android.projection.gearhead",
    getPackageManager: () => packageManager,
  };
  const classes = {
    "android.app.ActivityThread": { currentApplication: () => application },
    "android.content.ComponentName": { unflattenFromString: (component) => component },
  };
  const rpc = {};
  runInNewContext(source, {
    rpc,
    Java: { perform: (callback) => callback(), use: (name) => classes[name] },
  });

  const entries = Array.from(services.keys(), (component) => ({
    component, profile: "PERSONAL", native: false,
  }));
  entries.push(
    { component: "test.maps/.Activity", profile: "PERSONAL", native: true },
    { component: "test.missing/.Browser", profile: "PERSONAL", native: false },
    { ...entries[0], profile: "WORK" },
  );
  const labels = await rpc.exports.labels(entries);

  assert.deepEqual(Array.from(labels, ({ label }) => label), ["Music", "Audiobooks", "Maps"]);
});
