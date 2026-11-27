// Follow the visible template activity to its existing AndroidX car app connection.
const gearhead = "com.google.android.projection.gearhead";
const serviceKey = "GH.CarAppServiceKey";
const appKey = "AppKey";
const sessionKey = "TemplateCarActivity.SESSION_ID";
const requestKey = "com.androidlab.headunit.SERVICE_LINK_REQUEST";
const actionView = "android.intent.action.VIEW";
const intentType = "android.content.Intent";

function onMain(action) {
  return new Promise((resolve, reject) => {
    Java.perform(() => Java.scheduleOnMainThread(() => {
      try { resolve(action()); }
      catch (error) { reject(error); }
    }));
  });
}

function field(type, name) {
  const value = type.class.getDeclaredField(name);
  value.setAccessible(true);
  return value;
}

function concrete(object) {
  const type = Java.cast(object, Java.use("java.lang.Object")).getClass();
  return Java.cast(object, Java.use(String(type.getName())));
}

function accessor(methods, returnType) {
  const matches = Array.from(methods).filter((method) => method.getParameterTypes().length === 0 &&
    String(method.getReturnType().getName()) === returnType);
  if (matches.length !== 1) throw new Error("Android Auto did not expose one accessor returning " + returnType + ".");
  const method = matches[0];
  const owner = Java.use(String(method.getDeclaringClass().getName()));
  return owner[String(method.getName())].overload();
}

function templateActivity() {
  const service = Java.use("com.google.android.projection.gearhead.apphost.TemplateNavigationService");
  const activity = accessor(service.class.getDeclaredMethods(), "java.lang.Class");
  return Java.use(String(activity.call(service.$new()).getName()));
}

function currentHost(key, session, activityType) {
  const loader = activityType.class.getClassLoader();
  const Map = Java.use("java.util.Map");
  const Modifier = Java.use("java.lang.reflect.Modifier");
  const pair = Java.use("android.util.Pair").create(key, session);
  const matches = [];
  // The template cache has a singleton getter, an active flag and a map keyed by (app, session).
  for (const group of Java.enumerateMethods("*!g(): */su")) {
    if (!group.loader || !group.loader.equals(loader)) continue;
    const factory = Java.ClassFactory.get(group.loader);
    for (const entry of group.classes) {
      if (!entry.methods.includes(`g(): ${entry.name}`)) continue;
      const type = factory.use(entry.name);
      const fields = Array.from(type.class.getDeclaredFields());
      const singleton = fields.find((f) => f.getType().equals(type.class) && Modifier.isStatic(f.getModifiers()));
      const active = fields.find((f) => String(f.getName()) === "a" && String(f.getType().getName()) === "boolean");
      const hosts = fields.find((f) => String(f.getName()) === "b" && Map.class.equals(f.getType()));
      if (!singleton || !active || !hosts) continue;
      for (const f of [singleton, active, hosts]) f.setAccessible(true);
      const cache = singleton.get(null);
      if (!cache || !active.getBoolean(cache)) continue;
      const host = Java.cast(hosts.get(cache), Map).get(pair);
      if (host) matches.push(concrete(host));
    }
  }
  if (matches.length !== 1) throw new Error("Android Auto did not expose one active host for this app and car session.");
  return matches[0];
}

function templateInstance(component, displays, expected, use) {
  const ActivityThread = Java.use("android.app.ActivityThread");
  if (String(ActivityThread.currentPackageName()) !== gearhead) {
    throw new Error("The selected process is not Android Auto.");
  }
  const System = Java.use("java.lang.System");
  const Activity = templateActivity();
  const currentIntent = accessor(Activity.class.getMethods(), "android.content.Intent");
  const fragmentField = field(Activity, "r");
  const Fragment = Java.use(String(fragmentField.getType().getName()));
  const keyField = field(Fragment, "s");
  const AppKey = Java.use(String(keyField.getType().getName()));
  const ComponentName = Java.use("android.content.ComponentName");
  const AppProfile = Java.use("java.lang.Enum");
  return new Promise((resolve, reject) => {
    const candidates = [];
    let failure;
    Java.choose(Activity.$className, {
      onMatch(activity) {
        try {
          if (!activity.getClass().equals(Activity.class)) return;
          const fragment = Java.cast(fragmentField.get(activity), Fragment);
          const view = fragment.getView();
          const display = view?.getDisplay();
          if (!display || !view.isShown() || !fragment.isResumed() ||
              !displays.includes(display.getDisplayId())) return;
          const current = currentIntent.call(activity);
          if (!current) return;
          const storedKey = current.getStringExtra(serviceKey);
          const bound = keyField.get(fragment);
          if (!bound) return;
          const key = Java.cast(bound, AppKey);
          const serializedKey = String(key.c());
          if (storedKey ? String(storedKey) !== serializedKey : !key.equals(AppKey.b(current))) return;
          if (String(Java.cast(field(AppKey, "b").get(key), AppProfile).name()) !== "PERSONAL" ||
              String(Java.cast(field(AppKey, "a").get(key), ComponentName).flattenToString()) !== component) return;
          const session = Activity.b.overload().call(activity);
          if (session.getDisplayType() !== 0) return;
          const host = currentHost(key, session, Activity);
          const appHost = concrete(host.a("app"));
          if (!fragment.equals(concrete(appHost.r()).c())) return;
          const hostType = Java.use(host.$className);
          const connection = concrete(field(hostType, "b").get(host));
          const type = Java.use(connection.$className);
          if (String(Java.cast(field(type, "c").get(connection), ComponentName).flattenToString()) !== component ||
              Java.cast(field(type, "m").get(connection), AppProfile).ordinal() !== 2) return;
          const target = field(type, "h").get(connection);
          const Proxy = Java.use("androidx.car.app.ICarApp$Stub$Proxy");
          if (!target || !Proxy.class.isInstance(target)) return;
          const remote = Java.cast(target, Proxy).asBinder();
          if (!remote.isBinderAlive()) return;
          const match = {
            display: display.getDisplayId(), session: String(session.getSessionId()),
            activity: System.identityHashCode(activity), connection: System.identityHashCode(connection),
          };
          if (expected && Object.keys(match).some((name) => match[name] !== expected[name])) return;
          candidates.push({ activity: Java.retain(activity), connection: Java.retain(connection), remote: Java.retain(remote),
            serializedKey, explicitSession: current.getStringExtra(sessionKey), match });
        } catch (error) {
          failure ??= error;
        }
      },
      onComplete() {
        if (failure) reject(failure);
        else if (candidates.length > 1) reject(new Error("More than one visible car session owns the selected app."));
        else {
          try { resolve(use(candidates[0] ?? null)); }
          catch (error) { reject(error); }
        }
      },
    });
  });
}

function sameBoundConnection(connection, bindingState, boundApp, remote) {
  const state = bindingState.get(connection);
  const target = boundApp.get(connection);
  const Enum = Java.use("java.lang.Enum");
  const Proxy = Java.use("androidx.car.app.ICarApp$Stub$Proxy");
  const Object = Java.use("java.lang.Object");
  return state && Java.cast(state, Enum).ordinal() === 2 && target && Proxy.class.isInstance(target) &&
    Java.cast(remote, Object).equals(Java.cast(target, Proxy).asBinder()) && remote.isBinderAlive();
}

function matchesIntent(intent, component, url, request) {
  return intent && String(intent.getAction()) === actionView &&
    String(intent.getComponent()?.flattenToString()) === component && String(intent.getDataString()) === url &&
    String(intent.getStringExtra(requestKey)) === request;
}

function deliver(component, candidate, url) {
  const Looper = Java.use("android.os.Looper");
  if (!Looper.getMainLooper().equals(Looper.myLooper())) throw new Error("Android Auto left the main thread.");
  if (typeof url !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\x00-\x1f\x7f]+$/.test(url)) {
    return { status: "failed", error: "Specify a valid URI for the projected service." };
  }
  const { activity, connection, remote } = candidate;
  const Activity = Java.use(activity.$className);
  const Connection = Java.use(connection.$className);
  const Intent = Java.use(intentType);
  const Uri = Java.use("android.net.Uri");
  const ComponentName = Java.use("android.content.ComponentName");
  const lastIntent = field(Connection, "k");
  const bindingState = field(Connection, "m");
  const boundApp = field(Connection, "h");
  if (!lastIntent.getType().equals(Intent.class) || !sameBoundConnection(connection, bindingState, boundApp, remote)) {
    return { status: "failed", error: "The selected projected service connection changed." };
  }
  const request = String(Java.use("java.util.UUID").randomUUID().toString());
  const intent = Intent.$new(actionView, Uri.parse(url));
  intent.setComponent(ComponentName.unflattenFromString(component));
  const put = Intent.putExtra.overload("java.lang.String", "java.lang.String");
  put.call(intent, appKey, candidate.serializedKey);
  put.call(intent, serviceKey, candidate.serializedKey);
  put.call(intent, requestKey, request);
  if (candidate.explicitSession) put.call(intent, sessionKey, String(candidate.explicitSession));
  Activity.e.overload(intentType).call(activity, intent);
  // The bound host stores the original intent in k before submitting its onNewIntent call.
  const recorded = lastIntent.get(connection);
  const receipt = recorded && Java.cast(recorded, Intent);
  if (!matchesIntent(receipt, component, url, request) || !sameBoundConnection(connection, bindingState, boundApp, remote)) {
    return { status: "failed", error: "Android Auto did not confirm submission through the selected template host." };
  }
  return { status: "submitted" };
}

rpc.exports = {
  async probe(component, displays) {
    return await onMain(() => templateInstance(component, displays, null, (candidate) => candidate?.match ?? null));
  },
  async deliver(component, expected, url) {
    try {
      return await onMain(() => templateInstance(component, [expected.display], expected,
        (candidate) => candidate ? deliver(component, candidate, url)
          : { status: "failed", error: "The selected projected car session changed." }));
    } catch (error) {
      return { status: "failed", error: "Android Auto could not confirm submission through the template host: " + String(error) };
    }
  },
};
