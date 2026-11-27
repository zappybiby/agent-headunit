"use strict";

rpc.exports = {
  labels(entries) {
    return new Promise((resolve, reject) => Java.perform(() => {
      try {
        const app = Java.use("android.app.ActivityThread").currentApplication();
        if (!app || app.getPackageName().toString() !== "com.google.android.projection.gearhead") {
          throw new Error("The Android Auto application context is unavailable.");
        }
        const pm = app.getPackageManager();
        const ComponentName = Java.use("android.content.ComponentName");
        const result = [];
        for (const entry of entries) {
          if (entry.profile !== "PERSONAL") continue;
          try {
            const component = ComponentName.unflattenFromString(entry.component);
            if (!component) continue;
            const info = entry.native ? pm.getActivityInfo(component, 0) : pm.getServiceInfo(component, 0);
            const hasServiceLabel = info.labelRes.value !== 0 || info.nonLocalizedLabel.value !== null;
            const label = entry.native || hasServiceLabel
              ? info.loadLabel(pm)
              : pm.getApplicationLabel(info.applicationInfo.value);
            if (label && label.toString().trim())
              result.push({component: entry.component, profile: entry.profile, label: label.toString()});
          } catch (_) { /* A missing component must not affect the other entries. */ }
        }
        resolve(result);
      } catch (error) { reject(error); }
    }));
  }
};
