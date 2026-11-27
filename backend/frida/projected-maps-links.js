const gearhead = "com.google.android.projection.gearhead";
const maps = "com.google.android.apps.maps/com.google.android.apps.gmm.car.GmmCarProjectionService";
const requestKey = "com.androidlab.headunit.MAPS_LINK_REQUEST";
const intentClass = "android.content.Intent";
const componentClass = "android.content.ComponentName";
const regionClass = "com.google.android.gms.car.display.CarRegionId";
const displayClass = "com.google.android.gms.car.display.CarDisplayId";

function onMain(action) {
  return new Promise((resolve, reject) => {
    Java.perform(() => Java.scheduleOnMainThread(() => {
      try { resolve(action()); }
      catch (error) { reject(error); }
    }));
  });
}

function fieldType(type, name) {
  return Java.use(String(type.class.getDeclaredField(name).getType().getName()));
}

function member(type, name, expectedType) {
  const field = type.class.getDeclaredField(name);
  if (String(field.getType().getName()) !== expectedType) throw new Error("Unexpected Maps host field type.");
  field.setAccessible(true);
  return (value) => field.get(value);
}

function method(type, name, returnType, args, isStatic = false) {
  const reflection = type.class.getDeclaredMethod(name, Java.array("java.lang.Class", args.map((arg) => Java.use(arg).class)));
  const modifier = Java.use("java.lang.reflect.Modifier");
  if (String(reflection.getReturnType().getName()) !== returnType || modifier.isStatic(reflection.getModifiers()) !== isStatic) {
    throw new Error("Unexpected Maps host method signature.");
  }
  return type[name].overload(...args);
}

function activityLayout(Activity) {
  const Base = Java.use(String(Activity.class.getSuperclass().getName()));
  const Owner = fieldType(Base, "b");
  const Holder = fieldType(Activity, "M");
  const Projection = fieldType(Activity, "O");
  if (!Java.use("android.os.IInterface").class.isAssignableFrom(Projection.class)) {
    throw new Error("The car activity does not expose its projection interface.");
  }
  return {
    id: Activity.$className, Owner, Projection,
    app: member(Base, "d", componentClass), region: member(Base, "z", regionClass),
    pid: member(Base, "k", "int"), owner: member(Base, "b", Owner.$className),
    state: member(Activity, "K", "int"), bound: member(Activity, "R", "boolean"),
    ready: member(Activity, "S", "boolean"), proxy: member(Activity, "O", Projection.$className),
    intentHolder: member(Activity, "M", Holder.$className), currentIntent: member(Holder, "a", intentClass),
    ownerActivity: method(Owner, "e", Base.$className, [regionClass]),
  };
}

function routerLayout(Router) {
  const intentArgs = Java.array("java.lang.Class", [Java.use(intentClass).class]);
  const AppKey = Java.use(String(Router.class.getDeclaredMethod("b", intentArgs).getReturnType().getName()));
  for (const name of ["c", "d", "e"]) member(Router, name, "java.util.List");
  member(AppKey, "a", componentClass);
  method(Router, "i", "void", [intentClass]);
  return {
    Router, AppKey, appKey: method(AppKey, "b", AppKey.$className, [intentClass], true),
    appName: method(AppKey, "c", "java.lang.String", []),
    router: method(Router, "a", Router.$className, [], true),
    route: method(Router, "e", "void", [intentClass]),
    routingActive: member(Router, "f", "boolean"),
  };
}

function discover(signature, inspect, role) {
  const matches = [];
  for (const group of Java.enumerateMethods("*!*" + signature + "/su")) {
    if (!group.loader || !group.loader.equals(Java.classFactory.loader)) continue;
    for (const { name } of group.classes) {
      try { matches.push(inspect(Java.use(name))); }
      catch { /* Other classes also use these Android parameter types. */ }
    }
  }
  if (matches.length !== 1) throw new Error("Android Auto did not expose one matching " + role + ".");
  return matches[0];
}

function findRouter() {
  return discover("(" + regionClass + "): boolean", routerLayout, "projected app router");
}

function verifyEnvironment() {
  const application = Java.use("android.app.ActivityThread").currentApplication();
  const properties = Java.use("android.os.SystemProperties");
  if (!application || String(application.getPackageName()) !== gearhead ||
      String(properties.get.overload("java.lang.String").call(properties, "ro.kernel.qemu")) !== "1") {
    throw new Error("The selected process is not Android Auto on an emulator.");
  }
}

function mapsInstance(component, regionId, mapsPid) {
  verifyEnvironment();
  if (component !== maps || !Number.isSafeInteger(regionId) || regionId <= 0 ||
      !Number.isSafeInteger(mapsPid) || mapsPid <= 0) throw new Error("Specify the stock projected Maps region and process.");
  const layout = discover("(com.google.android.gms.car.CarActivityLayoutParams, java.util.UUID): void",
    activityLayout, "car activity manager");
  const routing = findRouter();
  const System = Java.use("java.lang.System");
  const Component = Java.use(componentClass);
  const Intent = Java.use(intentClass);
  const Region = Java.use(regionClass);
  const areaIdOf = member(Region, "g", "int");
  const carDisplayOf = member(Region, "h", displayClass);
  const carDisplayIdOf = member(Java.use(displayClass), "b", "int");
  return new Promise((resolve, reject) => {
    const candidates = [];
    let failure;
    Java.choose(layout.id, {
      onMatch(manager) {
        try {
          if (String(Java.cast(layout.app(manager), Component).flattenToString()) !== component ||
              Number(String(layout.pid(manager))) !== mapsPid) return;
          const region = layout.region(manager);
          if (Number(String(areaIdOf(region))) !== regionId ||
              Number(String(carDisplayIdOf(carDisplayOf(region)))) !== 0) return;
          if (Number(String(layout.state(manager))) !== 3 || String(layout.bound(manager)) !== "true" ||
              String(layout.ready(manager)) !== "true") return;
          const currentIntent = layout.currentIntent(layout.intentHolder(manager));
          if (!currentIntent) return;
          const key = routing.appKey.call(routing.AppKey, Java.cast(currentIntent, Intent));
          if (!key || String(routing.appName.call(key)) !== component) return;
          const owner = Java.cast(layout.owner(manager), layout.Owner);
          if (!manager.equals(layout.ownerActivity.call(owner, region))) return;
          const rawProxy = layout.proxy(manager);
          if (!rawProxy || !layout.Projection.class.isInstance(rawProxy)) return;
          const proxy = Java.cast(rawProxy, Java.use("android.os.IInterface"));
          const binder = proxy.asBinder();
          if (!binder.isBinderAlive() || String(binder.getInterfaceDescriptor()) !== "com.google.android.gms.car.ICarProjection") return;
          candidates.push({ router: routing.Router.$className, regionId, mapsPid,
            manager: System.identityHashCode(manager), proxy: System.identityHashCode(proxy) });
        } catch (error) {
          failure ??= error;
        }
      },
      onComplete() {
        if (failure) reject(failure);
        else if (candidates.length > 1) reject(new Error("More than one active car activity matches the stock Maps region."));
        else resolve(candidates[0] ?? null);
      },
    });
  });
}

function verifyRequest(component, url, requestId) {
  if (component !== maps || typeof url !== "string" || !/^(geo|google\.navigation):[^\s\x00-\x1f\x7f]+$/.test(url)) {
    throw new Error("Projected Maps links require the stock Maps component and a geo or google.navigation URI.");
  }
  if (typeof requestId !== "string" || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(requestId)) {
    throw new Error("Projected Maps links require a unique request ID.");
  }
}

rpc.exports = {
  async probe(component, regionId, mapsPid) {
    return await onMain(() => mapsInstance(component, regionId, mapsPid));
  },
  async sendLink(component, url, requestId, expectedRouter) {
    verifyRequest(component, url, requestId);
    return await onMain(() => {
      verifyEnvironment();
      const layout = findRouter();
      if (layout.Router.$className !== expectedRouter) throw new Error("The selected Android Auto router changed.");
      const router = layout.router.call(layout.Router);
      if (!router || String(layout.routingActive(router)) !== "true") {
        throw new Error("Android Auto's projected app router is inactive.");
      }
      const Intent = Java.use(intentClass);
      const Uri = Java.use("android.net.Uri");
      const Component = Java.use(componentClass);
      const intent = Intent.$new("android.intent.action.VIEW", Uri.parse(url));
      intent.setComponent(Component.unflattenFromString(component));
      const put = Intent.putExtra.overload("java.lang.String", "java.lang.String");
      put.call(intent, "AppKey", component);
      put.call(intent, requestKey, requestId);
      layout.route.call(router, intent);
      return { submitted: true };
    });
  },
};
