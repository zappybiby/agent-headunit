import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import manifest from '../package.json' with { type: 'json' };

export const upstreamVersion = manifest.devDependencies['agent-device'];

function packageRootFromEntry(entry) {
  const directory = path.dirname(entry);
  const filename = path.basename(entry);
  if (filename === 'agent-device.mjs' && path.basename(directory) === 'bin') {
    return path.dirname(directory);
  }
  if (filename !== 'daemon.js' && filename !== 'bin.js') return;

  const src = path.basename(directory) === 'internal' ? path.dirname(directory) : directory;
  const dist = path.dirname(src);
  if (path.basename(src) === 'src' && path.basename(dist) === 'dist') return path.dirname(dist);
}

async function ifPresent(read) {
  try {
    return await read();
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
}

export async function findUpstreamRuntimeRoot() {
  if (!process.argv[1]) return;
  const entry = await ifPresent(() => realpath(process.argv[1]));
  if (!entry) return;
  const launcher = packageRootFromEntry(entry);
  const roots = launcher ? [launcher] : (createRequire(entry).resolve.paths('agent-device') ?? [])
    .map((directory) => path.join(directory, 'agent-device'));
  for (const root of roots) {
    const manifest = await ifPresent(() => readFile(path.join(root, 'package.json'), 'utf8'));
    if (!manifest) continue;
    const info = JSON.parse(manifest);
    if (info.name === 'agent-device') return await realpath(root);
    return;
  }
}

export async function loadUpstreamRuntime(root, host) {
  const upstreamRoot = root ?? await findUpstreamRuntimeRoot();
  if (!upstreamRoot) return;

  // Reuse the executing package's command scope and its device shell argument checks.
  const chunk = (name) => import(pathToFileURL(path.join(upstreamRoot, 'dist', 'src', name)).href);
  if (host) {
    const { v: AppError } = await chunk('sdk-contracts.js');
    if (typeof AppError !== 'function' || !(host.createError('COMMAND_FAILED', 'Headunit runtime identity') instanceof AppError)) {
      return;
    }
  }
  await chunk('platform-runtime-android-adb-host.js');
  const [{ createCloudWebDriverRuntime }, { createAndroidPlatformRuntime }, { Y: deviceIdentity }, { runTreeAlertAction },
    { parseWebDriverAndroidSnapshotNodes }, { n: acquireProviderKeyboard }, { i: attachScreenReaderOrder },
    { t: attachReaderFacts }, { buildAndroidScreenReaderOrderEvidence: buildReaderEvidence },
    { n: deviceShellArgv }, { r: resolveAndroidApp }, { t: readAndroidCurrentUserId, b: lowerAndroidTouchPlan },
    { d: buildScrollGesturePlan, p: clipScrollViewportAboveKeyboard, y: scrollKeyboardOccludesSurfaceError },
    { n: buildGesturePlan }, { t: scopeSnapshotNodes },
    { a: createHostAudioProbeCaptureOperations },
    { n: resolveManagedProcessIdentity, t: inspectManagedProcess, i: terminateManagedProcessSet }] = await Promise.all([
    chunk('plugin.js'), chunk('runtime4.js'), chunk('sdk-device.js'), chunk('alert-tree-driver.js'),
    chunk('webdriver-android-source.js'), chunk('tap-keyboard-occlusion.js'),
    chunk('snapshot-private-evidence.js'), chunk('ui-hierarchy-node.js'), chunk('snapshot-screen-reader-order.js'),
    chunk('device-shell.js'), chunk('app-deployment-resolution.js'), chunk('permission-grant-state.js'),
    chunk('scroll-gesture.js'), chunk('gesture-plan.js'), chunk('snapshot-desktop-projection.js'),
    chunk('src10.js'), chunk('platform-runtime-screen-recording-process-host.js'),
  ]);
  if ([createCloudWebDriverRuntime, createAndroidPlatformRuntime, deviceIdentity, runTreeAlertAction,
    parseWebDriverAndroidSnapshotNodes, acquireProviderKeyboard, attachScreenReaderOrder,
    attachReaderFacts, buildReaderEvidence, deviceShellArgv, resolveAndroidApp, readAndroidCurrentUserId,
    lowerAndroidTouchPlan, buildScrollGesturePlan, clipScrollViewportAboveKeyboard,
    scrollKeyboardOccludesSurfaceError, buildGesturePlan, scopeSnapshotNodes, createHostAudioProbeCaptureOperations,
    resolveManagedProcessIdentity, inspectManagedProcess, terminateManagedProcessSet]
    .some((value) => typeof value !== 'function')) {
    throw new Error(`This agent-device installation has incompatible runtime exports. Tested with ${upstreamVersion}.`);
  }
  return Object.freeze({ createCloudWebDriverRuntime, createAndroidPlatformRuntime, deviceIdentity, runTreeAlertAction,
    parseWebDriverAndroidSnapshotNodes, acquireProviderKeyboard, attachScreenReaderOrder, attachReaderFacts,
    buildReaderEvidence, deviceShellArgv, resolveAndroidApp, readAndroidCurrentUserId, lowerAndroidTouchPlan,
    buildScrollGesturePlan, clipScrollViewportAboveKeyboard, scrollKeyboardOccludesSurfaceError, buildGesturePlan,
    scopeSnapshotNodes, createHostAudioProbeCaptureOperations, resolveManagedProcessIdentity, inspectManagedProcess,
    terminateManagedProcessSet });
}
