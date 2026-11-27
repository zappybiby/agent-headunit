// Gearhead 18.0.664264-release legacy projection from its active Maps car activity manager.
const gearhead = "com.google.android.projection.gearhead";
const maps = "com.google.android.apps.maps/com.google.android.apps.gmm.car.GmmCarProjectionService";
const requestKey = "com.androidlab.headunit.MAPS_LINK_REQUEST";
const newIntent = 13;
const newIntentComplete = 14;
const onNewIntentTransaction = 3;

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

function verifyBuild() {
  const application = Java.use("android.app.ActivityThread").currentApplication();
  const properties = Java.use("android.os.SystemProperties");
  if (!application || String(application.getPackageName()) !== gearhead ||
      String(properties.get.overload("java.lang.String").call(properties, "ro.kernel.qemu")) !== "1") {
    throw new Error("The selected process is not Android Auto on an emulator.");
  }
  const manager = application.getPackageManager();
  const info = manager.getPackageInfo.overload("java.lang.String", "int").call(manager, gearhead, 0);
  if (String(info.versionName.value) !== "18.0.664264-release" || String(info.getLongVersionCode()) !== "180664264") {
    throw new Error("Projected Maps links require Android Auto 18.0.664264-release.");
  }
}

function mapsInstance(component, regionId, mapsPid, expected, use) {
  verifyBuild();
  if (component !== maps || !Number.isSafeInteger(regionId) || regionId <= 0 ||
      !Number.isSafeInteger(mapsPid) || mapsPid <= 0) throw new Error("Specify the stock projected Maps region and process.");
  const System = Java.use("java.lang.System");
  const Component = Java.use("android.content.ComponentName");
  const Intent = Java.use("android.content.Intent");
  const AppKey = Java.use("nfl");
  const Manager = Java.use("jat");
  const Proxy = Java.use("rmo");
  const appOf = member("izz", "d");
  const areaOf = member("izz", "z");
  const areaIdOf = member("com.google.android.gms.car.display.CarRegionId", "g");
  const carDisplayOf = member("com.google.android.gms.car.display.CarRegionId", "h");
  const carDisplayIdOf = member("com.google.android.gms.car.display.CarDisplayId", "b");
  const pidOf = member("izz", "k");
  const ownerOf = member("izz", "b");
  const stateOf = member("jbt", "K");
  const boundOf = member("jbt", "R");
  const readyOf = member("jbt", "S");
  const proxyOf = member("jbt", "O");
  const handlerOf = member("jbt", "H");
  const currentIntentHolderOf = member("jbt", "M");
  const currentIntentOf = member("jbp", "a");
  return new Promise((resolve, reject) => {
    const candidates = [];
    let failure;
    Java.choose("jbt", {
      onMatch(manager) {
        try {
          if (String(Java.cast(appOf(manager), Component).flattenToString()) !== component ||
              Number(String(pidOf(manager))) !== mapsPid) return;
          const region = areaOf(manager);
          if (Number(String(areaIdOf(region))) !== regionId ||
              Number(String(carDisplayIdOf(carDisplayOf(region)))) !== 0) return;
          if (Number(String(stateOf(manager))) !== 3 || String(boundOf(manager)) !== "true" ||
              String(readyOf(manager)) !== "true") return;
          const currentIntent = currentIntentOf(currentIntentHolderOf(manager));
          if (!currentIntent) return;
          const key = AppKey.b(Java.cast(currentIntent, Intent));
          if (!key || String(key.c()) !== component) return;
          const owner = Java.cast(ownerOf(manager), Manager);
          if (!manager.equals(owner.e.overload("com.google.android.gms.car.display.CarRegionId").call(owner, region))) return;
          const rawProxy = proxyOf(manager);
          if (!rawProxy || !Proxy.class.isInstance(rawProxy)) return;
          const proxy = Java.cast(rawProxy, Proxy);
          if (!proxy.asBinder().isBinderAlive()) return;
          const match = { regionId, mapsPid, manager: System.identityHashCode(manager), proxy: System.identityHashCode(proxy) };
          if (expected && Object.keys(match).some((field) => expected[field] !== match[field])) return;
          candidates.push({ match, proxy: Java.retain(proxy), manager: Java.retain(manager),
            handler: Java.retain(handlerOf(manager)) });
        } catch (error) {
          failure ??= error;
        }
      },
      onComplete() {
        if (failure) reject(failure);
        else if (candidates.length > 1) reject(new Error("More than one active car activity matches the stock Maps region."));
        else {
          try { resolve(use(candidates[0] ?? null)); }
          catch (error) { reject(error); }
        }
      },
    });
  });
}

function dispatch(candidate, url) {
  const Looper = Java.use("android.os.Looper");
  if (!Looper.getMainLooper().equals(Looper.myLooper())) throw new Error("Android Auto left the main thread.");
  const Intent = Java.use("android.content.Intent");
  const Uri = Java.use("android.net.Uri");
  const Component = Java.use("android.content.ComponentName");
  const Message = Java.use("android.os.Message");
  const Queue = Java.use("java.util.Queue");
  const Router = Java.use("neo");
  const Process = Java.use("android.os.Process");
  const BinderProxy = Java.use("android.os.BinderProxy");
  const remote = candidate.proxy.asBinder();
  if (!BinderProxy.class.isInstance(remote)) throw new Error("The selected Maps connection is not a remote app process.");
  const token = String(Java.use("java.util.UUID").randomUUID().toString());
  const pendingOf = member("izx", "c");
  const send = Java.use("rmo").m.overload("android.content.Intent");
  const transact = BinderProxy.transact.overload("int", "android.os.Parcel", "android.os.Parcel", "int");
  const handle = Java.use("jbs").m.overload("izz", "android.os.Message");

  function targeted(intent) {
    return intent && Intent.class.isInstance(intent) &&
      String(Java.cast(intent, Intent).getStringExtra(requestKey)) === token;
  }

  return new Promise((resolve) => {
    let timer;
    let dispatched = false;
    let finished = false;
    let sendingThread;
    let accepted;
    function finish(status, nativeCompletion, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      send.implementation = null;
      transact.implementation = null;
      handle.implementation = null;
      resolve({ status, nativeCompletion, error });
    }
    try {
      transact.implementation = function (code, data, reply, flags) {
        const result = transact.call(this, code, data, reply, flags);
        if (result && code === onNewIntentTransaction && (flags & 1) && sendingThread === Process.myTid() &&
            this.equals(remote)) accepted = true;
        return result;
      };
      send.implementation = function (intent) {
        const matches = this.equals(candidate.proxy) && targeted(intent) &&
          String(intent.getComponent()?.flattenToString()) === maps;
        if (!matches) return send.call(this, intent);
        sendingThread = Process.myTid();
        accepted = false;
        try {
          return send.call(this, intent);
        } finally {
          sendingThread = undefined;
          if (accepted) {
            dispatched = true;
            clearTimeout(timer);
            timer = setTimeout(() => Java.perform(() => finish("dispatched", false)), 1200);
          }
        }
      };
      handle.implementation = function (manager, message) {
        let completion = false;
        if (dispatched && message.what.value === newIntentComplete && manager.equals(candidate.manager) &&
            this.equals(candidate.handler)) {
          const pending = Java.cast(pendingOf(this), Queue).peek();
          if (pending) {
            const request = Java.cast(pending, Message);
            completion = request.what.value === newIntent && targeted(request.obj.value);
          }
        }
        const result = handle.call(this, manager, message);
        if (completion) finish("dispatched", true);
        return result;
      };
      const intent = Intent.$new("android.intent.action.VIEW", Uri.parse(url));
      intent.setComponent(Component.unflattenFromString(maps));
      const put = Intent.putExtra.overload("java.lang.String", "java.lang.String");
      put.call(intent, "AppKey", maps);
      put.call(intent, requestKey, token);
      timer = setTimeout(() => Java.perform(() =>
        finish("failed", false, "Android Auto did not dispatch the link to the selected Maps projection.")), 8000);
      const router = Router.a.overload().call(Router);
      Router.e.overload("android.content.Intent").call(router, intent);
    } catch (error) {
      if (dispatched) finish("dispatched", false);
      else finish("failed", false, "Android Auto could not dispatch the projected Maps link: " + String(error));
    }
  });
}

rpc.exports = {
  async probe(component, regionId, mapsPid) {
    return await onMain(() => mapsInstance(component, regionId, mapsPid, null,
      (candidate) => candidate?.match ?? null));
  },
  async deliver(component, expected, url) {
    if (typeof url !== "string" || !/^(geo|google\.navigation):[^\s\x00-\x1f\x7f]+$/.test(url)) {
      throw new Error("Projected Maps links require a geo or google.navigation URI.");
    }
    return await onMain(() => mapsInstance(component, expected.regionId, expected.mapsPid, expected,
      (candidate) => candidate ? dispatch(candidate, url)
        : { status: "failed", nativeCompletion: false, error: "The selected Maps projection changed." }));
  },
};
