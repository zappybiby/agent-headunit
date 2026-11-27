import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { emulatorAudioFormat, resolveEmulatorAudioEndpoint, startEmulatorAudioStream } from './emulator-audio-transport.mjs';

const workerFile = fileURLToPath(import.meta.url);
const workerArgument = '--headunit-emulator-audio-sampler';
const backend = 'android-emulator-grpc';
const stopGraceMs = 1_000;
const silenceDb = -90;

function validTiming(durationMs, bucketMs) {
  return Number.isInteger(durationMs) && durationMs >= 100 && durationMs <= 120_000 &&
    Number.isInteger(bucketMs) && bucketMs >= 100 && bucketMs <= 10_000;
}

function workerMarker(marker) {
  return typeof marker?.command === 'string' && marker.command.includes(path.basename(workerFile)) &&
    marker.command.includes(workerArgument);
}

function send(target, message) {
  return new Promise((resolve, reject) => {
    if (!target.connected) {
      reject(new Error('The receiver audio sampler disconnected.'));
      return;
    }
    target.send(message, (error) => error ? reject(error) : resolve());
  });
}

async function writeStatus(statusPath, staging, status) {
  await writeFile(staging, JSON.stringify(status), { flag: 'wx', mode: 0o600 });
  try {
    await rename(staging, statusPath);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

async function startSampler({ endpoint, directories, statusPath, durationMs, bucketMs, resolveManagedProcessIdentity }) {
  const child = fork(workerFile, [workerArgument], {
    detached: true,
    windowsHide: true,
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const staging = path.join(path.dirname(statusPath), `.headunit-audio-${randomUUID()}.tmp`);
  let statusWrites = Promise.resolve();
  let workerError;
  let finished = false;
  let startupError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { startupError = (startupError + chunk).slice(-1200); });
  const online = Promise.withResolvers();
  const exited = new Promise((resolve) => {
    child.once('close', (code) => { finished = true; resolve(code); });
    child.once('error', () => { workerError ??= 'Could not start or communicate with the receiver audio sampler.'; });
  });
  child.on('message', (message) => {
    if (message?.kind === 'online') online.resolve();
    if (message?.kind === 'failure') workerError = message.message;
    if (message?.kind !== 'status') return;
    statusWrites = statusWrites.then(() => writeStatus(statusPath, staging, message.status));
    void statusWrites.catch(() => { child.kill(); });
  });
  const wait = exited.then(async (code) => {
    await statusWrites;
    return { exitCode: code ?? 1, stdout: '', stderr: workerError ?? '' };
  });
  void wait.catch(() => {});
  child.unref();
  child.channel?.unref();

  let termination;
  function terminate() {
    termination ??= (async () => {
      if (!finished) {
        const timer = setTimeout(() => { child.kill(); }, stopGraceMs);
        try {
          await send(child, { kind: 'stop' }).catch(() => { child.kill(); });
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      await wait;
    })();
    return termination;
  }

  try {
    const ready = await Promise.race([online.promise.then(() => true), exited.then(() => false),
      sleep(4500, false, { ref: false })]);
    if (!ready) {
      throw new Error(`The receiver audio sampler did not start.${startupError ? ' ' + startupError.trim() : ''}`);
    }
    let marker = await resolveManagedProcessIdentity(child.pid);
    if (!marker && !finished) marker = await resolveManagedProcessIdentity(child.pid);
    if (!marker || finished) throw new Error('Windows did not report the receiver audio sampler process identity.');
    if (!workerMarker(marker) || marker.pid !== child.pid) {
      throw new Error('The receiver audio sampler process identity did not match the child.');
    }
    await send(child, { kind: 'start', endpoint, directories, durationMs, bucketMs });
    return Object.freeze({ marker, wait, terminate });
  } catch (error) {
    await terminate().catch(() => {});
    throw error;
  }
}

export function createEmulatorAudioCaptureOperations({
  serial, avdName, device, owner, createHostAudioProbeCaptureOperations,
  resolveManagedProcessIdentity, inspectManagedProcess, terminateManagedProcessSet, directories,
}) {
  const host = Object.freeze({
    info: Object.freeze({
      source: 'system-audio', backend, sourceCount: 1,
      notes: () => ['Samples mixed audio output from the selected Open Headunit receiver emulator.'],
    }),
    async start({ durationMs, bucketMs, statusPath }) {
      if (!validTiming(durationMs, bucketMs) || !path.isAbsolute(statusPath)) {
        throw new Error('Invalid receiver audio timing or status path.');
      }
      const endpoint = await resolveEmulatorAudioEndpoint({ serial, avdName, directories });
      if (!endpoint) throw new Error('The selected receiver has no authenticated local emulator audio endpoint.');
      return await startSampler({ endpoint, directories, statusPath, durationMs, bucketMs, resolveManagedProcessIdentity });
    },
    async inspectProcess(marker) {
      return workerMarker(marker) ? await inspectManagedProcess(marker) : 'ownership-lost';
    },
    async terminateProcess(marker) {
      return workerMarker(marker) ? await terminateManagedProcessSet([marker]) : 'ownership-lost';
    },
  });
  return createHostAudioProbeCaptureOperations({ host, device, owner });
}

function dbfs(value) {
  return value > 0 ? Math.max(silenceDb, Math.min(0, Math.round(20 * Math.log10(value)))) : silenceDb;
}

function createMeter({ durationMs, bucketMs }) {
  const startedAt = new Date().toISOString();
  const began = performance.now();
  const rmsDbfs = [];
  const peakDbfs = [];
  let heard = false;
  let squares = 0;
  let peak = 0;
  let samples = 0;

  return {
    add({ pcm }) {
      for (let offset = 0; offset < pcm.length; offset += emulatorAudioFormat.sampleBytes) {
        const sample = Math.abs(pcm.readInt16LE(offset));
        squares += sample * sample;
        peak = Math.max(peak, sample);
        samples++;
      }
    },
    bucket() {
      const rms = dbfs(samples ? Math.sqrt(squares / samples) / 32_768 : 0);
      const peakDb = dbfs(peak / 32_768);
      rmsDbfs.push(rms);
      peakDbfs.push(peakDb);
      heard ||= rms > silenceDb || peakDb > silenceDb;
      samples = squares = peak = 0;
    },
    snapshot(reason) {
      return {
        audio: 'probe', source: 'system-audio', backend, sourceCount: 1,
        state: reason ? 'stopped' : 'running', active: !reason, heard,
        durationMs, bucketMs, startedAt,
        elapsedMs: Math.min(durationMs, Math.floor(performance.now() - began)),
        sampleCount: rmsDbfs.length, rmsDbfs, peakDbfs,
        ...(reason ? { stoppedAt: new Date().toISOString(), reason } : {}),
      };
    },
  };
}

async function sample(config, control) {
  const { durationMs, bucketMs, directories, endpoint: expected } = config;
  if (!validTiming(durationMs, bucketMs)) throw new Error('Invalid receiver audio sampling duration.');
  const endpoint = await resolveEmulatorAudioEndpoint({ serial: expected.serial, avdName: expected.avdName, directories });
  if (endpoint?.pid !== expected.pid || endpoint.port !== expected.port) {
    throw new Error('The selected receiver emulator changed before audio capture started.');
  }
  const { signal } = control;
  signal.throwIfAborted();
  const meter = createMeter({ durationMs, bucketMs });
  const capture = startEmulatorAudioStream({ endpoint, signal, onSamples: (packet) => meter.add(packet) });
  let limit;
  let checkpoint;
  let checkpointError;
  try {
    await capture.ready;
    await send(process, { kind: 'status', status: meter.snapshot() });
    limit = setTimeout(() => control.abort('completed'), durationMs);
    checkpoint = setInterval(() => {
      if (signal.aborted) return;
      meter.bucket();
      void send(process, { kind: 'status', status: meter.snapshot() }).catch((error) => {
        checkpointError = error;
        control.abort('disconnected');
      });
    }, bucketMs);
    const result = await capture.done;
    if (checkpointError) throw checkpointError;
    if (result !== 'cancelled') throw new Error('The receiver audio stream ended before capture completed.');
    if (process.connected) {
      meter.bucket();
      await send(process, { kind: 'status', status: meter.snapshot(signal.reason) });
    }
  } finally {
    clearTimeout(limit);
    clearInterval(checkpoint);
    await capture.cancel().catch(() => {});
  }
}

async function runWorker() {
  const control = new AbortController();
  const admitted = Promise.withResolvers();
  const onMessage = (message) => {
    if (message?.kind === 'start') admitted.resolve(message);
    if (message?.kind === 'stop') control.abort('stopped');
  };
  const onDisconnect = () => control.abort('disconnected');
  const onAbort = () => admitted.reject(new Error('The receiver audio sampler was cancelled.'));
  process.on('message', onMessage);
  process.once('disconnect', onDisconnect);
  control.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => control.abort('startup-timeout'), 7_000);
  try {
    await send(process, { kind: 'online' });
    const config = await admitted.promise;
    clearTimeout(timer);
    await sample(config, control);
  } catch (error) {
    if (process.connected) {
      await send(process, { kind: 'failure', message: error instanceof Error ? error.message : 'Receiver audio sampling failed.' })
        .catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.off('message', onMessage);
    process.off('disconnect', onDisconnect);
    control.signal.removeEventListener('abort', onAbort);
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === workerFile && process.argv[2] === workerArgument && process.send) {
  await runWorker();
}
