import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http2';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveEmulatorAudioEndpoint, startEmulatorAudioStream } from '../provider/emulator-audio-transport.mjs';

const serial = 'emulator-5556';
const avdName = 'aa4721_receiver';
const fixtureToken = 'test-local-bearer';
const sampleFormat = Buffer.from([0x08, 0x80, 0xf7, 0x02, 0x10, 0x01, 0x18, 0x01]);
const responseHeaders = { ':status': 200, 'content-type': 'application/grpc' };

async function advertisement(t, port, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'headunit-audio-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fields = {
    'avd.id': avdName,
    'port.serial': '5556',
    'port.adb': '5557',
    'grpc.port': String(port),
    'grpc.token': fixtureToken,
    ...overrides,
  };
  const record = Object.entries(fields).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`).join('\r\n');
  await writeFile(path.join(directory, `pid_${process.pid}.ini`), record);
  return directory;
}

async function fixture(t, onRequest) {
  const server = createServer();
  server.on('stream', (stream, headers) => {
    stream.on('error', () => {});
    onRequest(stream, headers);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const directory = await advertisement(t, server.address().port);
  return await resolveEmulatorAudioEndpoint({ serial, avdName, directories: [directory] });
}

function grpcFrame(payload) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

test('discovery requires one live advertisement for the exact receiver and its bearer', async (t) => {
  const receiver = await advertisement(t, 8556);
  const other = await advertisement(t, 8554, { 'avd.id': 'android17_morphe', 'port.serial': '5554' });
  const endpoint = await resolveEmulatorAudioEndpoint({ serial, avdName, directories: [other, receiver, receiver] });
  assert.deepEqual(endpoint, { serial, avdName, pid: process.pid, port: 8556 });
  assert.equal(JSON.stringify(endpoint).includes(fixtureToken), false);
  assert.equal(await resolveEmulatorAudioEndpoint({ serial: 'emulator-5554', avdName, directories: [receiver, other] }), undefined);
  const jwtOnly = await advertisement(t, 8556, { 'grpc.token': undefined, 'grpc.jwks': 'ignored' });
  assert.equal(await resolveEmulatorAudioEndpoint({ serial, avdName, directories: [jwtOnly] }), undefined);
  await assert.rejects(resolveEmulatorAudioEndpoint({ serial, avdName, directories: [receiver, jwtOnly] }), /More than one/);
  assert.throws(() => startEmulatorAudioStream({ endpoint: { ...endpoint }, onSamples() {} }), /unavailable/);
});

test('capture authenticates one RPC, decodes split PCM packets and drains on abort', async (t) => {
  const requestObserved = Promise.withResolvers();
  const serverClosed = Promise.withResolvers();
  const pcm = Buffer.from([0x00, 0x80, 0xff, 0x7f]);
  const frame = grpcFrame(Buffer.concat([Buffer.from([0x0a, sampleFormat.length]), sampleFormat,
    Buffer.from([0x10, 0xac, 0x02, 0x1a, pcm.length]), pcm]));
  const endpoint = await fixture(t, (stream, headers) => {
    stream.once('close', serverClosed.resolve);
    const request = [];
    stream.on('data', (data) => request.push(data));
    stream.on('end', () => {
      requestObserved.resolve({ headers, body: Buffer.concat(request) });
      stream.respond(responseHeaders);
      stream.write(frame.subarray(0, 3));
      setImmediate(() => stream.write(Buffer.concat([frame.subarray(3), frame])));
    });
  });
  const packets = [];
  const signal = new AbortController();
  const capture = startEmulatorAudioStream({ endpoint, signal: signal.signal, onSamples(packet) {
    packets.push(packet);
    if (packets.length === 2) signal.abort();
  } });
  t.after(capture.cancel);
  await capture.ready;
  const request = await requestObserved.promise;
  assert.equal(request.headers[':path'], '/android.emulation.control.EmulatorController/streamAudio');
  assert.equal(request.headers.authorization, `Bearer ${fixtureToken}`);
  assert.deepEqual(request.body, grpcFrame(sampleFormat));
  assert.equal(await capture.done, 'cancelled');
  assert.equal(await capture.cancel(), 'cancelled');
  await serverClosed.promise;
  assert.deepEqual(packets, [{ pcm, capturedAtUs: 300 }, { pcm, capturedAtUs: 300 }]);
});

test('terminal RPC errors and truncated frames cannot be reported as successful audio', async (t) => {
  const rejected = await fixture(t, (stream) => {
    stream.respond({ ...responseHeaders, 'grpc-status': '16', 'grpc-message': fixtureToken });
    stream.end();
  });
  const refused = startEmulatorAudioStream({ endpoint: rejected, onSamples: assert.fail });
  await assert.rejects(refused.ready, /gRPC 16/);
  await assert.rejects(refused.done, (error) => /gRPC 16/.test(error.message) && !error.message.includes(fixtureToken));

  const truncated = await fixture(t, (stream) => {
    stream.respond(responseHeaders, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(Buffer.from([0, 0, 0, 0, 12, 0x1a]));
  });
  const incomplete = startEmulatorAudioStream({ endpoint: truncated, onSamples: assert.fail });
  await incomplete.ready;
  await assert.rejects(incomplete.done, /truncated audio frame/);
});

test('a silent audio stream can be armed through the same authenticated connection', async (t) => {
  const requests = [];
  let audio;
  const endpoint = await fixture(t, (stream, headers) => {
    requests.push({ method: headers[':path'].split('/').at(-1), token: headers.authorization, session: stream.session });
    if (requests.length === 1) {
      audio = stream;
      return; // The emulator waits to emit initial metadata until it has PCM.
    }
    stream.respond(responseHeaders, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.end(grpcFrame(Buffer.from([0x18, 1])));
  });
  const packets = [];
  const capture = startEmulatorAudioStream({ endpoint, startupTimeoutMs: 1_000, onSamples(packet) {
    packets.push(packet);
  } });
  t.after(() => capture.cancel().catch(() => {}));
  await capture.ready;
  assert.deepEqual(requests.map(({ method }) => method), ['streamAudio', 'getStatus']);
  assert.equal(requests[0].session, requests[1].session);
  assert.ok(requests.every(({ token }) => token === `Bearer ${fixtureToken}`));
  assert.deepEqual(packets, []);

  audio.respond(responseHeaders, { waitForTrailers: true });
  audio.on('wantTrailers', () => audio.sendTrailers({ 'grpc-status': '7' }));
  audio.end();
  await assert.rejects(capture.done, /gRPC 7/);
});
