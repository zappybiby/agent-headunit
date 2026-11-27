import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../../backend/frida/projected-maps-links.js", import.meta.url), "utf8");
const gearhead = "com.google.android.projection.gearhead";
const maps = "com.google.android.apps.maps/com.google.android.apps.gmm.car.GmmCarProjectionService";
const region = "com.google.android.gms.car.display.CarRegionId";
const display = "com.google.android.gms.car.display.CarDisplayId";
const intent = "android.content.Intent";
const componentType = "android.content.ComponentName";
const layoutParams = "com.google.android.gms.car.CarActivityLayoutParams";
const projectionDescriptor = "com.google.android.gms.car.ICarProjection";
const requestId = "43ee29d4-a8c3-4a08-8d0a-551c4ff0d175";
const url = "geo:0,0?q=Park";
const descriptor = (name) => ({ getName: () => name });
const shapes = [
  ["jbt", "izz", "jat", "jbp", "rmo", "rmq", "nfl", "neo"],
  ["jen", "jct", "jdn", "jej", "rsb", "rsd", "njt", "niw"],
  ["jnf", "jlk", "jme", "jnb", "sbs", "sbu", "nth", "nsk"],
];
const renamed = ["qa", "qb", "qc", "qd", "qe", "qf", "qg", "qh"];

function frida(observed, change = () => {}, fixture = {}) {
  const classes = {
    [intent]: {}, [componentType]: {},
    [region]: { fields: { g: "int", h: display } }, [display]: { fields: { b: "int" } },
    unrelated: { methods: { [`g(${region})`]: ["boolean", true], [`h(${layoutParams},java.util.UUID)`]: ["void", false] } },
  };
  const projections = [];
  for (const [manager, base, owner, holder, proxy, projection, key, router] of observed) {
    Object.assign(classes, {
      [manager]: { super: base, fields: { K: "int", M: holder, O: projection, R: "boolean", S: "boolean" },
        methods: { [`u(${layoutParams},java.util.UUID)`]: ["void", false] } },
      [base]: { fields: { b: owner, d: componentType, k: "int", z: region } },
      [owner]: { methods: { [`e(${region})`]: [base, false] } },
      [holder]: { fields: { a: intent } },
      [projection]: { accepts: [proxy] },
      [key]: { fields: { a: componentType }, methods: { [`b(${intent})`]: [key, true], "c()": ["java.lang.String", false] } },
      [router]: { fields: { c: "java.util.List", d: "java.util.List", e: "java.util.List", f: "boolean" },
        methods: { "a()": [router, true], [`b(${intent})`]: [key, false], [`e(${intent})`]: ["void", false],
          [`i(${intent})`]: ["void", false], [`l(${region})`]: ["boolean", true] } },
    });
    projections.push(projection);
  }
  classes["android.os.IInterface"] = { accepts: projections };
  change(classes);
  const chosen = [];
  const loader = { equals: (value) => value === loader };
  const foreign = { equals: () => false };
  const types = {
    "android.app.ActivityThread": { currentApplication: () => ({ getPackageName: () => gearhead }) },
    "android.os.SystemProperties": { get: { overload: () => ({ call: () => "1" }) } },
    "java.lang.reflect.Modifier": { isStatic: (flags) => Boolean(flags & 8) },
    "java.lang.System": { identityHashCode: (object) => object.id },
    ...fixture.types,
  };
  const overloads = new Map();
  function overload(type, signature) {
    const key = `${type}.${signature}`;
    if (!overloads.has(key)) {
      overloads.set(key, { call: (receiver, ...args) => fixture.methods?.[key]?.(receiver, ...args) });
    }
    return overloads.get(key);
  }
  const Java = {
    perform: (action) => action(), scheduleOnMainThread: (action) => action(),
    array: (_, elements) => elements, cast: (value) => value,
    classFactory: { loader },
    enumerateMethods(query) {
      assert.match(query, /^\*!\*\(.*\): .*\/su$/);
      const suffix = query.slice(3, -3).replaceAll(", ", ",");
      const matches = Object.entries(classes).flatMap(([name, type]) => {
        const methods = Object.entries(type.methods ?? {}).map(([signature, [result]]) => `${signature}: ${result}`)
          .filter((signature) => signature.endsWith(suffix));
        return methods.length ? [{ name, methods }] : [];
      });
      return [
        { loader: foreign, classes: matches.filter(({ name }) => fixture.foreign?.includes(name)) },
        { loader, classes: matches.filter(({ name }) => !fixture.foreign?.includes(name)) },
      ];
    },
    choose(type, callbacks) {
      chosen.push(type);
      for (const instance of fixture.selectable?.[type] ?? []) callbacks.onMatch(instance);
      callbacks.onComplete();
    },
    use(name) {
      if (name in types) return types[name];
      const type = classes[name];
      if (!type) throw new Error(`No fixture class ${name}`);
      const wrapper = { $className: name, class: {
        ...descriptor(name), getSuperclass: () => descriptor(type.super),
        isAssignableFrom: (other) => type.accepts?.includes(other.getName()) ?? false,
        isInstance: (object) => object.className === name || (type.accepts?.includes(object.className) ?? false),
        getDeclaredField(field) {
          if (!type.fields?.[field]) throw new Error(`No field ${name}.${field}`);
          return { getType: () => descriptor(type.fields[field]), setAccessible() {}, get: (object) => object[field] };
        },
        getDeclaredMethod(method, args) {
          const [result, isStatic] = type.methods?.[`${method}(${args.map((arg) => arg.getName()).join(",")})`] ?? [];
          if (!result) throw new Error(`No method ${name}.${method}`);
          return { getReturnType: () => descriptor(result), getModifiers: () => isStatic ? 8 : 0 };
        },
      } };
      for (const signature of Object.keys(type.methods ?? {})) {
        wrapper[signature.split("(")[0]] = { overload: () => overload(name, signature) };
      }
      return wrapper;
    },
  };
  const rpc = {};
  runInNewContext(source, { Java, rpc });
  return { rpc: rpc.exports, chosen };
}

test("selects each observed Maps host shape and ignores valid classes from another loader", async () => {
  for (const shape of shapes) {
    const { rpc, chosen } = frida([shape, renamed], undefined, { foreign: [renamed[0], renamed[7]] });
    assert.equal(await rpc.probe(maps, 5, 1234), null);
    assert.deepEqual(chosen, [shape[0]]);
  }
});

test("refuses replaced fields, methods and ambiguous host shapes before choosing an activity", async () => {
  const cases = [
    [frida([]), /one matching car activity manager/],
    [frida(shapes), /one matching car activity manager/],
    [frida([shapes[1]], (classes) => { classes.jen.fields.M = "java.lang.Object"; }), /one matching car activity manager/],
    [frida([shapes[2]], (classes) => { classes.nsk.methods["a()"][1] = false; }), /one matching projected app router/],
    [frida([shapes[1], renamed], (classes) => { delete classes[renamed[0]]; }), /one matching projected app router/],
  ];
  for (const [{ rpc, chosen }, expected] of cases) {
    await assert.rejects(rpc.probe(maps, 5, 1234), expected);
    assert.deepEqual(chosen, []);
  }
});

test("checks the current native sender before submitting the scoped Maps intent", async () => {
  const router = { f: false };
  const requests = [];
  let lookups = 0;
  const { rpc } = frida([shapes[1]], undefined, {
    methods: {
      "niw.a()": () => { lookups++; return router; },
      [`niw.e(${intent})`]: (receiver, value) => requests.push({ receiver, value }),
    },
    types: {
      [intent]: {
        class: descriptor(intent),
        $new: (action, uri) => ({ action, uri, extras: {}, setComponent(value) { this.component = value; } }),
        putExtra: { overload: () => ({ call: (value, key, extra) => { value.extras[key] = extra; } }) },
      },
      "android.net.Uri": { parse: (value) => value },
      [componentType]: { unflattenFromString: (value) => value },
    },
  });
  await assert.rejects(rpc.sendLink(maps, url, requestId, "neo"), /router changed/);
  assert.equal(lookups, 0);
  await assert.rejects(rpc.sendLink(maps, url, requestId, "niw"), /router is inactive/);
  assert.deepEqual(requests, []);
  router.f = true;
  await assert.rejects(rpc.sendLink(maps, url, "invalid", "niw"), /unique request ID/);
  assert.equal((await rpc.sendLink(maps, url, requestId, "niw")).submitted, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].receiver, router);
  assert.equal(requests[0].value.action, "android.intent.action.VIEW");
  assert.equal(requests[0].value.uri, url);
  assert.equal(requests[0].value.component, maps);
  assert.equal(requests[0].value.extras.AppKey, maps);
  assert.equal(requests[0].value.extras["com.androidlab.headunit.MAPS_LINK_REQUEST"], requestId);
});

test("discovers a renamed manager and requires the active Maps projection Binder descriptor", async () => {
  const [managerName, , owner, , proxyName, , key, router] = renamed;
  const remote = { alive: true, descriptor: projectionDescriptor,
    isBinderAlive() { return this.alive; }, getInterfaceDescriptor() { return this.descriptor; } };
  const proxy = { id: 42, className: proxyName, asBinder: () => remote };
  const component = { flattenToString: () => maps };
  const manager = { id: 31, b: {}, d: component, k: 1234, z: { g: 5, h: { b: 0 } }, K: 3, R: true, S: true,
    O: proxy, M: { a: {} }, equals(value) { return this === value; } };
  const selectable = { [managerName]: [manager] };
  const { rpc } = frida([renamed], undefined, {
    selectable,
    methods: { [`${owner}.e(${region})`]: () => manager, [`${key}.b(${intent})`]: () => ({}), [`${key}.c()`]: () => maps },
  });
  assert.equal(await rpc.probe(maps, 6, 1234), null);
  assert.equal(await rpc.probe(maps, 5, 1235), null);
  const match = await rpc.probe(maps, 5, 1234);
  assert.deepEqual({ ...match }, { router, regionId: 5, mapsPid: 1234, manager: 31, proxy: 42 });
  remote.descriptor = "other.car.Projection";
  assert.equal(await rpc.probe(maps, 5, 1234), null);
  remote.descriptor = projectionDescriptor;
  remote.alive = false;
  assert.equal(await rpc.probe(maps, 5, 1234), null);
  remote.alive = true;
  selectable[managerName].push(manager);
  await assert.rejects(rpc.probe(maps, 5, 1234), /More than one active car activity/);
  selectable[managerName].pop();
  manager.K = 2;
  assert.equal(await rpc.probe(maps, 5, 1234), null);
  assert.doesNotMatch(source, /\.implementation\b|BinderProxy/);
});
