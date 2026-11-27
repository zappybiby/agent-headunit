const gearhead = "com.google.android.projection.gearhead";
const sessionClass = "androidx.car.app.Session";
const actionView = "android.intent.action.VIEW";
const requestKey = "com.androidlab.headunit.ANDROIDX_LINK_REQUEST";

let prepared = null;
let delivering = false;

function onMain(action) {
  return new Promise((resolve, reject) => {
    Java.perform(() => {
      try {
        Java.scheduleOnMainThread(() => {
          try { resolve(action()); }
          catch (error) { reject(error); }
        });
      } catch (error) { reject(error); }
    });
  });
}

function sameObject(expected, actual) {
  const identity = Java.use("java.util.IdentityHashMap").$new();
  identity.put(expected, expected);
  return identity.containsKey(actual);
}

function resumed(session) {
  return session && String(session.getLifecycle().getCurrentState().name()) === "RESUMED";
}

function hostMatches(service, uid) {
  const host = service.getHostInfo();
  return host && String(host.getPackageName()) === gearhead && host.getUid() === uid;
}

function sessionTypes(Session) {
  const Class = Java.use("java.lang.Class");
  const Modifier = Java.use("java.lang.reflect.Modifier");
  const env = Java.vm.getEnv();
  const base = Session.class;
  const retained = [];
  const types = [];
  let failed = false;
  try {
    // ART holds the class linker lock during enumeration. Resolve classes after it returns.
    Java.enumerateLoadedClasses({
      onMatch(name, handle) {
        try {
          if (!handle || handle.isNull()) failed = true;
          else if (name === sessionClass || env.isAssignableFrom(handle, base.$h)) {
            const reference = env.newGlobalRef(handle);
            if (reference.isNull()) failed = true;
            else retained.push({ name, reference });
          }
        } catch { failed = true; }
      },
      onComplete() {},
    });
    if (failed) throw new Error("Unable to verify loaded AndroidX session classes.");
    for (const { name, reference } of retained) {
      const type = Java.cast(reference, Class);
      if (name === sessionClass && !base.equals(type)) {
        throw new Error("The application uses more than one AndroidX session class loader.");
      }
      if (Modifier.isAbstract(type.getModifiers())) continue;
      const factory = Java.ClassFactory.get(type.getClassLoader());
      const concrete = factory.use(name);
      if (!type.equals(concrete.class)) throw new Error("The AndroidX session class changed.");
      types.push({ name, factory, concrete });
    }
  } finally {
    for (const { reference } of retained) env.deleteGlobalRef(reference);
  }
  return types;
}

function isOnlyResumedSession(Session, selected) {
  let found = false;
  for (const { name, factory, concrete } of sessionTypes(Session)) {
    let ambiguous = false;
    factory.choose(name, {
      onMatch(instance) {
        if (!concrete.class.equals(instance.getClass()) || !resumed(instance)) return;
        if (sameObject(selected, instance)) found = true;
        else {
          ambiguous = true;
          return "stop";
        }
      },
      onComplete() {},
    });
    if (ambiguous) return false;
  }
  return found;
}

function findBinding(component, hostUid) {
  const ComponentName = Java.use("android.content.ComponentName");
  const name = ComponentName.unflattenFromString(component);
  const processPackage = Java.use("android.app.ActivityThread").currentPackageName();
  if (!name || !processPackage || String(name.flattenToString()) !== component ||
      String(name.getPackageName()) !== String(processPackage) || String(processPackage) === gearhead ||
      !Number.isInteger(hostUid) || hostUid <= 0) {
    return { status: "unsupported", error: "The application process or Android Auto host could not be verified." };
  }
  const serviceClass = String(name.getClassName());
  const Service = Java.use(serviceClass);
  const factory = Java.ClassFactory.get(Service.class.getClassLoader());
  const CarAppService = factory.use("androidx.car.app.CarAppService");
  const Session = factory.use(sessionClass);
  if (!CarAppService.class.isAssignableFrom(Service.class)) {
    return { status: "unsupported", error: "The selected service does not expose the AndroidX car app API." };
  }

  let selected = null;
  let ambiguous = false;
  factory.choose(serviceClass, {
    onMatch(instance) {
      if (!Service.class.equals(instance.getClass())) return;
      const service = Java.cast(instance, CarAppService);
      const session = service.getCurrentSession();
      if (!resumed(session) || !hostMatches(service, hostUid)) return;
      if (selected) {
        ambiguous = true;
        return "stop";
      }
      selected = { service: Java.retain(service), session: Java.retain(session) };
    },
    onComplete() {},
  });
  if (!selected) return { status: "inactive", error: "The selected car app has no resumed Android Auto session." };
  if (ambiguous || !isOnlyResumedSession(Session, selected.session)) {
    return { status: "unsupported", error: "The application process does not have exactly one resumed car session." };
  }

  const Intent = Java.use("android.content.Intent");
  const CarContext = factory.use("androidx.car.app.CarContext");
  const context = selected.session.getCarContext();
  if (!context || String(context.getPackageName()) !== String(processPackage)) {
    return { status: "unsupported", error: "The selected car context does not belong to the application." };
  }
  const callbackMethod = selected.session.getClass().getMethod("onNewIntent", Java.array("java.lang.Class", [Intent.class]));
  const owner = callbackMethod.getDeclaringClass();
  const callback = Java.ClassFactory.get(owner.getClassLoader()).use(String(owner.getName()))
    .onNewIntent.overload("android.content.Intent");
  return { status: "ready", binding: { ...selected, component: name, context, callback,
    start: CarContext.startCarApp.overload("android.content.Intent"),
    pid: Java.use("android.os.Process").myPid(), hostUid } };
}

function nonce() {
  return String(Java.use("java.util.UUID").randomUUID().toString());
}

function sendLink(binding, component, url, attempt) {
  return new Promise((resolve) => {
    const { callback, session, service } = binding;
    let installed = false;
    let returned = false;
    let acknowledged = false;
    let finished = false;
    let timer;

    function finish(status, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (installed) callback.implementation = null;
      } catch {
        status = attempt.entered ? "uncertain" : "unsupported";
        error = "The AndroidX delivery observer could not be removed.";
      }
      resolve(error ? { status, error } : { status });
    }

    try {
      if (typeof url !== "string" || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) || callback.implementation) {
        return finish("unsupported", "The car app link or its delivery callback could not be prepared.");
      }
      const request = nonce();
      const Intent = Java.use("android.content.Intent");
      const intent = Intent.$new(actionView, Java.use("android.net.Uri").parse(url));
      intent.setComponent(binding.component);
      intent.putExtra.overload("java.lang.String", "java.lang.String").call(intent, requestKey, request);
      callback.implementation = function (incoming) {
        let matched = false;
        try {
          matched = !finished && attempt.entered && incoming && sameObject(session, this) &&
            String(incoming.getStringExtra(requestKey)) === request && String(incoming.getAction()) === actionView &&
            String(incoming.getComponent()?.flattenToString()) === component && String(incoming.getDataString()) === url;
        } catch {
          // Leave unrelated app callbacks untouched if their intent cannot be read.
        }
        let result;
        try { result = callback.call(this, incoming); }
        catch (error) {
          if (matched) finish("uncertain", "The projected app callback failed after the link was dispatched.");
          throw error;
        }
        if (matched) {
          acknowledged = true;
          if (returned) finish("accepted");
        }
        return result;
      };
      installed = true;
      if (!sameObject(session, service.getCurrentSession()) || !resumed(session) ||
          !hostMatches(service, binding.hostUid)) {
        return finish("inactive", "The selected Android Auto session changed before the link could be sent.");
      }
      timer = setTimeout(() => Java.perform(() =>
        finish("uncertain", "The projected app did not acknowledge the dispatched link.")), 8000);
      attempt.entered = true;
      binding.start.call(binding.context, intent);
      returned = true;
      if (acknowledged) finish("accepted");
    } catch {
      if (attempt.entered) finish("uncertain", "Android Auto did not confirm the dispatched link.");
      else finish("unsupported", "The AndroidX link could not be prepared in the selected app process.");
    }
  });
}

rpc.exports = {
  async probe(component, hostUid) {
    try {
      return await onMain(() => {
        if (delivering) return { status: "inactive", error: "An AndroidX link is already in progress." };
        prepared = null;
        const result = findBinding(component, hostUid);
        if (result.status !== "ready") return result;
        const { binding } = result;
        const match = { component, pid: binding.pid, hostUid, service: nonce(), session: nonce() };
        prepared = { binding, match };
        return { status: "ready", match };
      });
    } catch {
      return { status: "unsupported", error: "The AndroidX session API could not be verified in the selected app process." };
    }
  },

  async deliver(component, hostUid, match, url) {
    if (delivering) return { status: "uncertain", error: "An AndroidX link is already in progress." };
    delivering = true;
    const attempt = { entered: false };
    try {
      return await onMain(() => {
        const previous = prepared;
        prepared = null;
        const changed = { status: "inactive", error: "The selected Android Auto session changed before link dispatch." };
        if (!previous || component !== previous.match.component || hostUid !== previous.match.hostUid ||
            !match || Object.keys(previous.match).some((key) => previous.match[key] !== match[key])) return changed;
        const result = findBinding(component, hostUid);
        if (result.status !== "ready") return result;
        const { binding } = result;
        if (binding.pid !== match.pid || !sameObject(previous.binding.service, binding.service) ||
            !sameObject(previous.binding.session, binding.session)) return changed;
        return sendLink(binding, component, url, attempt);
      });
    } catch {
      return attempt.entered
        ? { status: "uncertain", error: "Android Auto did not confirm the dispatched link." }
        : { status: "unsupported", error: "The AndroidX link could not be prepared in the selected app process." };
    } finally {
      delivering = false;
    }
  },
};
