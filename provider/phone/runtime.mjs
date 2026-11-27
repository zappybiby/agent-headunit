const phoneOperations = [
  "readClipboard", "writeClipboard", "setFoldPose", "sendTelephonyEvent", "shake",
  "lockScreen", "unlockScreen", "power", "sleep", "wake",
  "networkDump", "perfFrames", "perfMemorySample",
];

const settingSubjects = {
  setSetting: [
    "wifi", "bluetooth", "airplane", "mobile-data", "keep-awake", "location", "animations",
    "appearance", "text-size", "fingerprint", "clear-app-state", "permission",
  ],
  readSetting: ["text-size"],
};

const scopedSettings = new Set(["clear-app-state", "permission"]);
const projectionShell = "com.google.android.projection.gearhead";
const packageFields = { networkDump: "appBundleId", perfFrames: "appId", perfMemorySample: "appId" };
const packagePattern = /^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)(?:\/[A-Za-z_.$][\w.$]*)?$/;
const unavailable = Object.freeze({ available: false, reason: "unsupported-platform-leaf" });
const available = Object.freeze({ available: true });

function subjectFact(fact, subject) {
  if (!fact?.available) return fact ?? unavailable;
  if (!fact.subjects) return available;
  return Object.hasOwn(fact.subjects, subject) ? fact.subjects[subject] : fact.unlisted ?? unavailable;
}

function restrictSettings(fact, names) {
  if (!fact?.available) return fact ?? unavailable;
  const subjects = Object.fromEntries(names.map((setting) => [setting, subjectFact(fact, setting)]));
  const unlisted = fact.unlisted ?? unavailable;
  return Object.values(subjects).some((subject) => subject.available) ? { available: true, subjects, unlisted } : unlisted;
}

export function phoneOperationFacts({ operations }) {
  return Object.fromEntries([
    ...phoneOperations.map((operation) => [operation, operations[operation] ?? unavailable]),
    ...Object.entries(settingSubjects).map(([operation, names]) => [operation, restrictSettings(operations[operation], names)]),
    ["sendPushNotification", operations.sendPushNotification ?? unavailable],
  ]);
}

function packageName(target) {
  return typeof target === "string" ? packagePattern.exec(target)?.[1] : undefined;
}

export function bindPhoneOperations({ facts, bindNative, createError, setLocation, resolvePackage }) {
  function refuse(operation, fact) {
    throw createError("UNSUPPORTED_OPERATION", fact?.hint ?? `The projecting phone does not support ${operation}.`, {
      reason: fact?.reason ?? unavailable.reason,
      dispatched: "no",
    });
  }

  async function pinPackage(target, operation) {
    const direct = packageName(target);
    if (direct) return direct;
    if (typeof target === "string" && target.trim() && resolvePackage && scopedSettings.has(operation)) {
      const resolved = packageName(await resolvePackage(target, operation));
      if (resolved) return resolved;
    }
    throw createError("INVALID_ARGS", `Select a projected Android app by package for ${operation}.`, { dispatched: "no" });
  }

  async function invoke(operation, input) {
    const isSetting = Object.hasOwn(settingSubjects, operation);
    const fact = isSetting ? subjectFact(facts[operation], input.setting) : facts[operation];
    if (!fact?.available) refuse(operation, fact);
    if (operation === "setSetting" && input.setting === "location" && input.state.toLowerCase() === "set") {
      if (!setLocation) refuse("emulator location coordinates");
      return await setLocation(input);
    }

    let nativeInput = input;
    if (operation === "setSetting" && scopedSettings.has(input.setting)) {
      const appBundleId = await pinPackage(input.appBundleId, input.setting);
      // The stock request passes the session app and an explicit app in the same field.
      if (appBundleId === projectionShell) {
        throw createError("INVALID_ARGS", `Select the projected app for settings ${input.setting}.`, { dispatched: "no" });
      }
      nativeInput = { ...input, appBundleId };
    } else if (Object.hasOwn(packageFields, operation)) {
      const key = packageFields[operation];
      nativeInput = { ...input, [key]: await pinPackage(input[key], operation) };
    }

    return await bindNative(({ operations, facts: current }) => {
      const currentFact = current.operations[operation];
      const admitted = isSetting ? subjectFact(currentFact, input.setting) : currentFact;
      if (!admitted?.available || typeof operations[operation] !== "function") refuse(operation, admitted);
      return operations[operation](nativeInput);
    });
  }

  return Object.fromEntries([...phoneOperations, ...Object.keys(settingSubjects)]
    .filter((operation) => facts[operation]?.available)
    .map((operation) => [operation, (input) => invoke(operation, input)]));
}
