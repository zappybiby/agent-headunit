import { claimProjectionTargets } from "./pair-claim.mjs";
import { stopPinnedEmulator, usesLocalAdb } from "./pair-lifecycle.mjs";

const available = Object.freeze({ available: true });
const operations = Object.freeze({ appState: available, ensureReady: available, shutdownTarget: available });
const serialPattern = /^emulator-[1-9]\d{3,4}$/;
const transportPattern = /^[1-9]\d*$/;

export function configuredPair(config, { call, upstreamRoot, createError, env }) {
  if (!config || !usesLocalAdb(env)) return;
  const { phoneAvd, receiverAvd } = config;
  const names = [phoneAvd, receiverAvd];
  const name = `headunit:${phoneAvd}`;
  const id = "headunit:avd:" + Buffer.from(JSON.stringify(names)).toString("base64url");
  const device = Object.freeze({ id, name, platform: "android", target: "mobile", kind: "emulator" });
  const ownsDevice = (target) => target.id === id && target.platform === device.platform &&
    target.target === device.target && target.kind === device.kind;

  async function readPair(signal) {
    signal?.throwIfAborted();
    const { members } = await call({ op: "pairStatus", phoneAvd, receiverAvd }, signal);
    if (!Array.isArray(members) || members.length !== names.length) {
      throw createError("COMMAND_FAILED", "Could not identify the configured Open Headunit pair.");
    }
    const present = members.filter((member) => member !== null);
    if (present.some((member) => !member || typeof member.serial !== "string" || !serialPattern.test(member.serial) ||
      typeof member.transportId !== "string" || !transportPattern.test(member.transportId) ||
      typeof member.booted !== "boolean") || new Set(present.map(({ serial }) => serial)).size !== present.length ||
      new Set(present.map(({ transportId }) => transportId)).size !== present.length) {
      throw createError("COMMAND_FAILED", "Could not identify the configured Open Headunit pair.");
    }
    return members;
  }

  function unchanged(before, after) {
    if (before.some((member, index) => member?.serial !== after[index]?.serial ||
        member?.transportId !== after[index]?.transportId)) {
      throw createError("DEVICE_NOT_FOUND", "The configured Open Headunit pair changed during the command.");
    }
  }

  function bind({ host, scope }) {
    const { signal } = scope;
    let readyMembers;
    function checkRequest() {
      signal.throwIfAborted();
      scope.checkDeadline?.();
    }
    async function ready(input = {}) {
      checkRequest();
      const members = await readPair(signal);
      if ((input.serial && input.serial !== id && input.serial !== members[0]?.serial) ||
          (input.androidSerialAllowlist && members.some((member) => !input.androidSerialAllowlist.includes(member?.serial)))) {
        throw createError("DEVICE_NOT_FOUND", "The Android selection excludes the configured Open Headunit pair.");
      }
      if (members.some((member) => !member?.booted)) {
        throw createError("DEVICE_NOT_FOUND", "Start both configured emulators before reading the projection.");
      }
      return members;
    }
    return {
      async ensureReady(input) { readyMembers = await ready(input); return { ...device, booted: true }; },
      async appState() {
        const members = readyMembers ?? await ready();
        const { package: app, activity } = await call({ op: "appstate", serial: members[0].serial,
          receiver: members[1].serial }, signal);
        unchanged(members, await readPair(signal));
        return { package: app, ...(activity && { activity }) };
      },
      async shutdownTarget() {
        checkRequest();
        async function claim(targets) {
          try {
            return await claimProjectionTargets(targets, { upstreamRoot, signal });
          } catch (error) {
            if (error?.details?.reason === "process_lock_timeout" && error.details.ownerLiveness === "live") {
              throw createError("DEVICE_IN_USE", "The configured Open Headunit pair is already claimed.", {
                reason: "DEVICE_CLAIM_LIVE_OWNER",
                hint: "Close the projection session that owns the pair before shutdown.",
              });
            }
            throw error;
          }
        }
        const releaseNames = await claim(names.map((avd) => "avd:" + avd));
        let releaseSerials;
        try {
          const members = await readPair(signal);
          const running = members.filter(Boolean).reverse();
          const serials = running.map(({ serial }) => serial);
          if (serials.length) releaseSerials = await claim(serials);
          unchanged(members, await readPair(signal));
          function assertOwned() {
            checkRequest();
            releaseNames.assertHeld();
            releaseSerials?.assertHeld();
          }
          for (const { serial, transportId } of running) {
            await stopPinnedEmulator({ serial, transportId, host, signal, createError, assertOwned });
          }
          assertOwned();
          if ((await readPair(signal)).some(Boolean)) {
            throw createError("COMMAND_FAILED", "A configured Open Headunit emulator is still running.");
          }
          return { success: true, exitCode: 0, stdout: "", stderr: "" };
        } finally {
          try { await releaseSerials?.(); } finally { await releaseNames(); }
        }
      },
    };
  }

  return Object.freeze({
    ownsDevice, bind, operations,
    async discover(request, signal) {
      if ((request.platform && request.platform !== device.platform) ||
          (request.target && request.target !== device.target) ||
          (request.deviceName && request.deviceName !== name) ||
          (request.serial && request.serial !== id) ||
          (!request.deviceName && !request.serial)) return null;
      const members = await readPair(signal);
      if (request.androidSerialAllowlist && members.some((member) => !request.androidSerialAllowlist.includes(member?.serial))) {
        return [];
      }
      return [{ ...device, booted: members.every((member) => member?.booted === true) }];
    },
  });
}
