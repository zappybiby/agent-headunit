import { metroOperations } from "./runtime.mjs";

const packageName = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const className = /^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const projectionPackages = new Set([
  "com.google.android.projection.gearhead",
  "com.andrerinas.headunitrevived",
  "com.andrerinas.openheadunit",
]);
const loopbackHosts = new Set(["127.0.0.1", "localhost"]);

function parseTarget(value) {
  if (typeof value !== "string") return undefined;
  const [id, component, extra] = value.trim().split("/");
  if (!packageName.test(id) || extra !== undefined ||
      (component !== undefined && !className.test(component))) return undefined;
  if (!component) return { id };
  const name = component.startsWith(".") ? id + component
    : component.includes(".") ? component : `${id}.${component}`;
  return { id, component: `${id}/${name}` };
}

export function projectedMetroOperations({
  openApplication, applications, phone, reverse, readCatalog, resolveLabel, closeProjected, runAdbShell, signal, leaseId, createError,
}) {
  let catalog;
  const verified = new Set();
  const reversed = new Set();
  function validatePackage(value) {
    const target = parseTarget(value);
    if (!target || projectionPackages.has(target.id)) {
      throw createError("INVALID_ARGS", "Select a projected app’s Android package for Metro.", { dispatched: "no" });
    }
    return target;
  }

  async function authorize(value) {
    const target = validatePackage(value);
    catalog ??= readCatalog();
    const apps = (await catalog)?.apps;
    if (!Array.isArray(apps)) {
      throw createError("COMMAND_FAILED", "Android Auto did not report its launcher apps.", { dispatched: "no" });
    }
    const components = new Set(apps.filter((app) => app.profile === "PERSONAL" && app.package === target.id)
      .map((app) => app.component));
    if (!components.size || (target.component && !components.has(target.component))) {
      throw createError("INVALID_ARGS", `${target.id} is not an Android Auto launcher app in the personal profile.`, {
        dispatched: "no",
      });
    }
    return { ...target, components };
  }

  async function verifySandbox(id) {
    if (verified.has(id)) return;
    const sandbox = await runAdbShell(phone, ["run-as", id, "id"],
      { allowFailure: true, timeoutMs: 5000 }, signal);
    if (sandbox.exitCode !== 0 || !/^uid=\d+/m.test(sandbox.stdout)) {
      throw createError("COMMAND_FAILED", `${id} must be a debuggable build on the projecting phone to use Metro.`, {
        dispatched: "no",
      });
    }
    verified.add(id);
  }

  async function prepareLoopback(values, id) {
    let bundle;
    if (values?.bundleUrl?.trim()) {
      try {
        bundle = new URL(values.bundleUrl.trim());
      } catch {
        throw createError("INVALID_ARGS", "Specify a valid Metro bundle URL.", { dispatched: "no" });
      }
      if (bundle.protocol !== "http:" && bundle.protocol !== "https:") bundle = undefined;
    }
    const host = values?.metroHost?.trim().toLowerCase() || bundle?.hostname;
    if (!loopbackHosts.has(host)) return;
    const specifiedPort = Number(values.metroPort);
    const port = Number.isInteger(specifiedPort) && specifiedPort > 0 && specifiedPort <= 65535
      ? specifiedPort : bundle && Number(bundle.port || (bundle.protocol === "https:" ? 443 : 80));
    if (!port || reversed.has(port)) return;
    if (!leaseId) {
      throw createError("UNSUPPORTED_OPERATION", "Metro loopback requires the active Open Headunit lease.", { dispatched: "no" });
    }
    await verifySandbox(id);
    signal?.throwIfAborted();
    const forwarded = await reverse({
      leaseId, provider: "headunit", devicePort: port, hostPort: port, name: "metro",
    });
    if (!forwarded) {
      throw createError("COMMAND_FAILED", "Could not reverse the Metro port to the projecting phone.");
    }
    reversed.add(port);
  }

  const stock = metroOperations(openApplication, applications, phone, reverse, createError);
  return {
    ...stock,
    async applyRuntimeHints(input) {
      const { id } = await authorize(input.appId);
      await prepareLoopback(input.values, id);
      return await stock.applyRuntimeHints({ ...input, appId: id });
    },
    async clearRuntimeHints(input) {
      if (!input.appId) return;
      const { id } = validatePackage(input.appId);
      return await stock.clearRuntimeHints({ ...input, appId: id });
    },
    async openApplication(input) {
      if (!input.runtimeHints) return await stock.openApplication(input);
      const resolved = await resolveLabel(input);
      if (resolved) {
        const pinned = parseTarget(resolved.component);
        if (!pinned?.component || pinned.id !== resolved.package) {
          throw createError("COMMAND_FAILED", "Android Auto did not identify one projected app for Metro.", {
            dispatched: "no",
          });
        }
        input = { ...input, appBundleId: pinned.id, target: pinned.component,
          positionals: [pinned.component, ...input.positionals.slice(1)] };
      }
      signal?.throwIfAborted();
      const app = await authorize(input.appBundleId);
      const requested = parseTarget(input.positionals?.[0]);
      const activity = input.execution?.activity;
      const component = activity
        ? parseTarget(activity.includes("/") ? activity : `${app.id}/${activity}`)?.component
        : requested?.component ?? app.component;
      if ((requested && requested.id !== app.id) || (activity && !component) ||
          (component && !app.components.has(component))) {
        throw createError("INVALID_ARGS", "Metro hints must target the selected projected app.", {
          dispatched: "no",
        });
      }
      if (!input.relaunch || !input.target) return await stock.openApplication(input);
      if (!component && app.components.size !== 1) {
        throw createError("INVALID_ARGS", "Choose one exact projected launcher component for the Metro relaunch.", {
          dispatched: "no",
        });
      }
      await verifySandbox(app.id);
      await prepareLoopback(input.runtimeHints.values, app.id);
      signal?.throwIfAborted();
      const started = Date.now();
      await closeProjected(component ?? app.components.values().next().value);
      const relaunchCloseDurationMs = Date.now() - started;
      const result = await stock.openApplication({ ...input, relaunch: false });
      return { ...result, timing: { ...result.timing, relaunchCloseDurationMs } };
    },
  };
}
