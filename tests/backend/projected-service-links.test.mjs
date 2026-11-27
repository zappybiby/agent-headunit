import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../../backend/frida/projected-service-links.js", import.meta.url), "utf8");
const component = "example.projected/example.projected.CarService";
const url = "example:message";
const request = "43ee29d4-a8c3-4a08-8d0a-551c4ff0d175";
const requestKey = "com.androidlab.headunit.SERVICE_LINK_REQUEST";

function fixture(onSend = (connection, intent) => { connection.k = intent; }) {
  const className = (name) => ({ equals: (type) => type.name === name });
  const remote = { isBinderAlive: () => true };
  const objectType = {};
  const connection = { $className: "Connection", h: { asBinder: () => remote }, m: { ordinal: () => 2 } };
  const activity = { $className: "Activity" };
  const sends = [];
  const wrappers = {
    "android.os.Looper": { getMainLooper: () => ({ equals: () => true }), myLooper: () => ({}) },
    "android.net.Uri": { parse: (value) => value },
    "android.content.ComponentName": { unflattenFromString: (name) => ({ flattenToString: () => name }) },
    "java.util.UUID": { randomUUID: () => request },
    "java.lang.Enum": {},
    "java.lang.Object": objectType,
    "androidx.car.app.ICarApp$Stub$Proxy": { class: { isInstance: (value) => Boolean(value.asBinder) } },
    "android.content.Intent": {
      class: { name: "Intent" },
      $new: (action, data) => ({
        action, data, extras: {}, getAction() { return this.action; }, getDataString() { return this.data; },
        setComponent(value) { this.component = value; }, getComponent() { return this.component; },
        getStringExtra(key) { return this.extras[key]; },
      }),
      putExtra: { overload: () => ({ call: (value, key, extra) => { value.extras[key] = extra; } }) },
    },
    Connection: { class: { getDeclaredField: (name) => ({
      getType: () => className(name === "k" ? "Intent" : "Other"),
      get: (owner) => owner[name], setAccessible() {},
    }) } },
    Activity: { e: { overload: () => ({ call: (owner, intent) => {
      assert.equal(owner, activity);
      sends.push(intent);
      onSend(connection, intent);
    } }) } },
  };
  const Java = {
    cast: (value, type) => type === objectType ? { equals: (other) => other === value } : value,
    use: (name) => wrappers[name],
  };
  const deliver = runInNewContext(`${source}\ndeliver`, { Java, rpc: {} });
  const candidate = { activity, connection, remote, serializedKey: "app-key", explicitSession: "session" };
  return { send: () => deliver(component, candidate, url), sends, connection };
}

test("reports host submission when the original connection retains the exact intent", () => {
  const { send, sends } = fixture();
  assert.deepEqual({ ...send() }, { status: "submitted" });
  assert.equal(sends.length, 1);
  assert.equal(sends[0].getComponent().flattenToString(), component);
  assert.equal(sends[0].getDataString(), url);
  assert.deepEqual(sends[0].extras, {
    AppKey: "app-key", "GH.CarAppServiceKey": "app-key", "TemplateCarActivity.SESSION_ID": "session",
    [requestKey]: request,
  });
  assert.doesNotMatch(source, /\.implementation\b|BinderProxy/);
});

test("fails closed on unchanged intents, wrong receipt values or changed bindings", () => {
  const cases = [
    () => {},
    (connection, intent) => { connection.k = { ...intent, extras: { ...intent.extras, [requestKey]: "other" } }; },
    (connection, intent) => { connection.k = { ...intent, data: `${url}2` }; },
    (connection, intent) => { connection.k = { ...intent, component: { flattenToString: () => "example/.Other" } }; },
    (connection, intent) => { connection.k = intent; connection.h = { asBinder: () => ({}) }; },
    (connection, intent) => { connection.k = intent; connection.m = { ordinal: () => 0 }; },
  ];
  for (const onSend of cases) {
    const { send, sends } = fixture(onSend);
    assert.equal(send().status, "failed");
    assert.equal(sends.length, 1);
  }
  const { send, sends, connection } = fixture();
  connection.m = { ordinal: () => 1 };
  assert.equal(send().status, "failed");
  assert.deepEqual(sends, []);
});
