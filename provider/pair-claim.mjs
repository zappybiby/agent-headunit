import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { upstreamVersion } from './upstream-runtime.mjs';

async function releaseClaims(releases) {
  const results = await Promise.allSettled(releases.map((claim) => claim.release()));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length === 1) throw failures[0].reason;
  if (failures.length > 1) {
    throw new AggregateError(failures.map((failure) => failure.reason), 'Failed to release Open Headunit claims');
  }
}

export function claimProjectionPair(phone, receiver, options) {
  if (!phone || !receiver || phone === receiver) throw new Error('An Open Headunit projection needs two distinct ADB serials.');
  return claimProjectionTargets([phone, receiver], options);
}

export async function claimProjectionTargets(targets, {
  upstreamRoot,
  signal,
  root = path.join(homedir(), '.agent-device', 'headunit-claims'),
}) {
  if (!targets.length || new Set(targets).size !== targets.length || targets.some((target) => typeof target !== 'string' || !target)) {
    throw new Error('An Open Headunit claim needs distinct device identities.');
  }

  const chunk = (name) => import(pathToFileURL(path.join(upstreamRoot, 'dist', 'src', name)).href);
  const [{ i: acquireProcessLock }, { m: readCurrentOwnerIdentity }] =
    await Promise.all([chunk('file.js'), chunk('sdk-io.js')]);
  if (typeof acquireProcessLock !== 'function' || typeof readCurrentOwnerIdentity !== 'function') {
    throw new Error(`This Agent Device installation has incompatible process lock exports. Tested with ${upstreamVersion}.`);
  }

  const { pid, startTime } = await readCurrentOwnerIdentity();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const releases = [];
  try {
    for (const serial of [...targets].sort()) {
      const id = createHash('sha256').update(serial).digest('hex');
      const release = await acquireProcessLock({
        lockDirPath: path.join(root, id),
        description: `Open Headunit projection claim for ${serial}`,
        owner: { pid, startTime, acquiredAtMs: Date.now() },
        timeoutMs: 0,
        signal,
      });
      releases.push(release);
    }
  } catch (error) {
    try {
      await releaseClaims(releases);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], error.message, { cause: error });
    }
    throw error;
  }

  let releasing;
  const release = () => {
    releasing ??= releaseClaims(releases).finally(() => { releasing = undefined; });
    return releasing;
  };
  return Object.assign(release, { assertHeld: () => {
    for (const claim of releases) claim.assertHeld();
  } });
}
