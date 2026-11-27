// Gearhead 18.0.664264-release TemplateNavigationService and its existing app connection.
const gearhead = "com.google.android.projection.gearhead";
const serviceKey = "GH.CarAppServiceKey";
const appKey = "AppKey";
const sessionKey = "TemplateCarActivity.SESSION_ID";
const requestKey = "com.androidlab.headunit.SERVICE_LINK_REQUEST";
const callbackType = "androidx.car.app.serialization.Bundleable";

function onMain(action) {
  return new Promise((resolve, reject) => {
    Java.perform(() => Java.scheduleOnMainThread(() => {
      try { resolve(action()); }
      catch (error) { reject(error); }
    }));
  });
}

function member(type, name) {
  const field = Java.use(type).class.getDeclaredField(name);
  field.setAccessible(true);
  return (value) => field.get(value);
}

function templateInstance(component, displays, expected, use) {
  const ActivityThread = Java.use("android.app.ActivityThread");
  if (String(ActivityThread.currentPackageName()) !== gearhead) {
    throw new Error("The selected process is not Android Auto.");
  }
  const System = Java.use("java.lang.System");
  const Activity = Java.use("kgp");
  const Fragment = Java.use("kha");
  const AppKey = Java.use("nfl");
  const KeyParser = Java.use("nev");
  const Host = Java.use("fxw");
  const AppHost = Java.use("hpk");
  const ViewOwner = Java.use("kgl");
  const Map = Java.use("java.util.Map");
  const Pair = Java.use("android.util.Pair");
  const Connection = Java.use("grl");
  const ComponentName = Java.use("android.content.ComponentName");
  const AppProfile = Java.use("java.lang.Enum");
  const fragmentOf = member("kgp", "r");
  const boundKeyOf = member("kha", "s");
  const appComponentOf = member("nfl", "a");
  const appProfileOf = member("nfl", "b");
  const currentCache = member("kgi", "d");
  const cacheActive = member("kgi", "a");
  const hostsOf = member("kgi", "b");
  const connectionOf = member("fxw", "b");
  const connectionComponentOf = member("grl", "c");
  const connectionStateOf = member("grl", "m");
  return new Promise((resolve, reject) => {
    const candidates = [];
    let failure;
    Java.choose("kgp", {
      onMatch(activity) {
        try {
          if (String(activity.getClass().getName()) !== "kgp") return;
          const fragment = Java.cast(fragmentOf(activity), Fragment);
          const view = fragment.getView();
          const display = view?.getDisplay();
          if (!display || !view.isShown() || !fragment.isResumed() ||
              !displays.includes(display.getDisplayId())) return;
          const current = activity.q();
          if (!current) return;
          const storedKey = current.getStringExtra(serviceKey);
          const intentKey = storedKey ? KeyParser.c(String(storedKey)) : AppKey.b(current);
          const bound = boundKeyOf(fragment);
          if (!intentKey || !bound || !intentKey.equals(bound)) return;
          const key = Java.cast(bound, AppKey);
          if (String(Java.cast(appProfileOf(key), AppProfile).name()) !== "PERSONAL" ||
              String(Java.cast(appComponentOf(key), ComponentName).flattenToString()) !== component) return;
          const session = Activity.b.overload().call(activity);
          if (session.getDisplayType() !== 0) return;
          const cache = currentCache(null);
          if (!cache || String(cacheActive(cache)) !== "true") return;
          const hosts = Java.cast(hostsOf(cache), Map);
          const existingHost = hosts.get(Pair.create(key, session));
          if (!existingHost) return;
          const host = Java.cast(existingHost, Host);
          const appHost = Java.cast(host.a("app"), AppHost);
          const owner = Java.cast(appHost.r(), ViewOwner);
          if (!fragment.equals(owner.c())) return;
          const connection = Java.cast(connectionOf(host), Connection);
          if (String(Java.cast(connectionComponentOf(connection), ComponentName).flattenToString()) !== component ||
              Java.cast(connectionStateOf(connection), AppProfile).ordinal() !== 2) return;
          const match = {
            display: display.getDisplayId(), session: String(session.getSessionId()),
            activity: System.identityHashCode(activity), connection: System.identityHashCode(connection),
          };
          if (expected && Object.keys(match).some((name) => match[name] !== expected[name])) return;
          candidates.push({ activity: Java.retain(activity), connection: Java.retain(connection),
            serializedKey: String(key.c()), explicitSession: current.getStringExtra(sessionKey), match });
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

function deliver(component, candidate, url) {
  const Looper = Java.use("android.os.Looper");
  if (!Looper.getMainLooper().equals(Looper.myLooper())) throw new Error("Android Auto left the main thread.");
  const Activity = Java.use("kgp");
  const Intent = Java.use("android.content.Intent");
  const Uri = Java.use("android.net.Uri");
  const ComponentName = Java.use("android.content.ComponentName");
  const Completion = Java.use("gra");
  const Call = Java.use("gqy");
  const request = String(Java.use("java.util.UUID").randomUUID().toString());
  const connectionOfCall = member("gqy", "a");
  const intentOfCall = member("gqy", "b");
  const invoke = Call.a.overload("java.lang.Object", "ikm");
  const construct = Completion.$init.overload("grl", "gjr", "ikm");
  const success = Completion.onSuccess.overload(callbackType);
  const failure = Java.use("gjf").onFailure.overload(callbackType);
  let callback = null;
  let matchingCall = false;

  return new Promise((resolve) => {
    let timer;
    let finished = false;
    function finish(status, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      invoke.implementation = null;
      construct.implementation = null;
      success.implementation = null;
      failure.implementation = null;
      resolve({ status, error });
    }
    try {
      invoke.implementation = function (recipient, task) {
        const raw = intentOfCall(this);
        const targeted = candidate.connection.equals(connectionOfCall(this)) && raw && Intent.class.isInstance(raw) &&
          String(Java.cast(raw, Intent).getStringExtra(requestKey)) === request;
        if (!targeted) return invoke.call(this, recipient, task);
        matchingCall = true;
        try { return invoke.call(this, recipient, task); }
        finally { matchingCall = false; }
      };
      construct.implementation = function (connection, context, task) {
        construct.call(this, connection, context, task);
        if (matchingCall && candidate.connection.equals(connection)) callback = Java.retain(this);
      };
      success.implementation = function (bundle) {
        const matched = callback && this.equals(callback);
        try {
          const result = success.call(this, bundle);
          if (matched) finish("accepted");
          return result;
        } catch (error) {
          if (matched) finish("failed", "Android Auto did not refresh the template after the link.");
          throw error;
        }
      };
      failure.implementation = function (bundle) {
        const matched = callback && this.equals(callback);
        try { return failure.call(this, bundle); }
        finally {
          if (matched) finish("failed", "The projected application rejected the link.");
        }
      };
      const intent = Intent.$new("android.intent.action.VIEW", Uri.parse(url));
      intent.setComponent(ComponentName.unflattenFromString(component));
      const put = Intent.putExtra.overload("java.lang.String", "java.lang.String");
      put.call(intent, appKey, candidate.serializedKey);
      put.call(intent, serviceKey, candidate.serializedKey);
      put.call(intent, requestKey, request);
      if (candidate.explicitSession) put.call(intent, sessionKey, String(candidate.explicitSession));
      timer = setTimeout(() => Java.perform(() =>
        finish("failed", "The projected application did not acknowledge the link.")), 8000);
      Activity.e.overload("android.content.Intent").call(candidate.activity, intent);
    } catch (error) {
      finish("failed", "Android Auto could not dispatch the projected link: " + String(error));
    }
  });
}

rpc.exports = {
  async probe(component, displays) {
    return await onMain(() => templateInstance(component, displays, null, (candidate) => candidate?.match ?? null));
  },
  async deliver(component, expected, url) {
    return await onMain(() => templateInstance(component, [expected.display], expected,
      (candidate) => candidate ? deliver(component, candidate, url)
        : { status: "failed", error: "The selected projected car session changed." }));
  },
};
