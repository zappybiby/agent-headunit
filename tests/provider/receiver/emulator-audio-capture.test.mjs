import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEmulatorAudioCaptureOperations } from '../../../provider/receiver/emulator-audio-capture.mjs';

const serial = 'emulator-5556';
const avdName = 'test-receiver';
const command = 'node emulator-audio-capture.mjs --headunit-emulator-audio-sampler';
const markerFor = (pid) => ({ pid, startTime: 'fixture-start', command });

function createHost(overrides = {}) {
  const device = { id: 'projection' };
  const owner = { kind: 'provider', instance: 'headunit' };
  return createEmulatorAudioCaptureOperations({
    serial, avdName, device, owner,
    createHostAudioProbeCaptureOperations(binding) {
      assert.equal(binding.device, device);
      assert.equal(binding.owner, owner);
      return binding.host;
    },
    resolveManagedProcessIdentity: async (pid) => markerFor(pid),
    ...overrides,
  });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'headunit-audio-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer();
  const rpc = Promise.withResolvers();
  const connectionClosed = Promise.withResolvers();
  server.on('stream', (stream, headers) => {
    rpc.resolve(headers);
    stream.on('error', () => {});
    stream.on('close', connectionClosed.resolve);
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
    // One stereo frame at half scale, carried in AudioPacket.audio.
    stream.write(Buffer.from([0, 0, 0, 0, 6, 0x1a, 4, 0, 0x40, 0, 0xc0]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await writeFile(path.join(directory, `pid_${process.pid}.ini`), [
    `avd.id=${avdName}`, 'port.serial=5556', `grpc.port=${server.address().port}`, 'grpc.token=fixture-token',
  ].join('\n'));
  const statusPath = path.join(directory, 'capture.json');
  return { directory, statusPath, rpc: rpc.promise, connectionClosed: connectionClosed.promise };
}

test('detached sampler publishes standard bucket results and closes the exact receiver stream', async (t) => {
  const sample = await fixture(t);
  const host = createHost({ directories: [sample.directory] });
  assert.equal(host.info.source, 'system-audio');
  assert.equal(host.info.backend, 'android-emulator-grpc');
  const process = await host.start({ durationMs: 240, bucketMs: 100, statusPath: sample.statusPath });
  t.after(process.terminate);
  assert.ok(process.marker.pid > 0);
  const request = await sample.rpc;
  assert.equal(request.authorization, 'Bearer fixture-token');
  assert.equal(request[':path'], '/android.emulation.control.EmulatorController/streamAudio');
  assert.deepEqual(await process.wait, { exitCode: 0, stdout: '', stderr: '' });
  await sample.connectionClosed;
  const status = JSON.parse(await readFile(sample.statusPath, 'utf8'));
  assert.equal(status.heard, true);
  assert.equal(status.state, 'stopped');
  assert.equal(status.active, false);
  assert.equal(status.reason, 'completed');
  assert.equal(status.rmsDbfs[0], -6);
  assert.deepEqual(status.peakDbfs, status.rmsDbfs);
  assert.equal(status.sampleCount, status.rmsDbfs.length);
  assert.equal(status.elapsedMs, 240);
  assert.equal((await readdir(sample.directory)).some((name) => name.endsWith('.tmp')), false);
});

test('a recorder that is not provably ours is stopped before sampling; recovery only uses its marker', async (t) => {
  const sample = await fixture(t);
  const unavailable = createHost({ directories: [sample.directory], resolveManagedProcessIdentity: async () => undefined });
  await assert.rejects(unavailable.start({ durationMs: 240, bucketMs: 100, statusPath: sample.statusPath }), /identity/);
  await assert.rejects(readFile(sample.statusPath), { code: 'ENOENT' });

  const marker = markerFor(process.pid);
  const recovery = createHost({ avdName: undefined, directories: ['/unavailable-discovery'],
    inspectManagedProcess: async (observed) => { assert.equal(observed, marker); return 'owned-alive'; },
    terminateManagedProcessSet: async (markers) => { assert.deepEqual(markers, [marker]); return 'terminated'; },
  });
  assert.equal(await recovery.inspectProcess(marker), 'owned-alive');
  assert.equal(await recovery.terminateProcess(marker), 'terminated');
  const foreign = { ...marker, command: 'unrelated-child' };
  assert.equal(await recovery.inspectProcess(foreign), 'ownership-lost');
  assert.equal(await recovery.terminateProcess(foreign), 'ownership-lost');
});
