import { readFile, readdir } from 'node:fs/promises';
import { connect, constants, sensitiveHeaders } from 'node:http2';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const controllerPath = '/android.emulation.control.EmulatorController';
const maxPacketBytes = 64 * 1024;
const maxDiscoveryBytes = 64 * 1024;
const quietAdmissionMs = 150;
const credentials = new WeakMap();

export const emulatorAudioFormat = Object.freeze({ sampleRate: 48_000, channels: 2, sampleBytes: 2 });

function discoveryDirectories() {
  const env = process.env;
  let roots;
  if (process.platform === 'win32') {
    roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Temp'), tmpdir()];
  } else if (process.platform === 'darwin') {
    roots = [path.join(homedir(), 'Library', 'Caches', 'TemporaryItems')];
  } else {
    roots = [env.XDG_RUNTIME_DIR, `/run/user/${process.getuid()}`, env.ANDROID_EMULATOR_HOME,
      env.ANDROID_PREFS_ROOT, env.ANDROID_SDK_HOME, path.join(homedir(), '.android')];
  }
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root, 'avd', 'running')))];
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EPERM') return false;
    throw error;
  }
}

function portNumber(value) {
  return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) <= 65_535
    ? Number(value) : undefined;
}

function parseAdvertisement(data) {
  const fields = new Map();
  for (const line of data.split(/\r?\n/)) {
    const pair = /^([\w.]+)=(.*)$/.exec(line);
    if (!pair) continue;
    if (fields.has(pair[1])) return;
    fields.set(pair[1], pair[2]);
  }
  return fields;
}

export async function resolveEmulatorAudioEndpoint({ serial, avdName, directories = discoveryDirectories() }) {
  const consolePort = portNumber(/^emulator-(\d+)$/.exec(serial)?.[1]);
  if (!consolePort || typeof avdName !== 'string' || !avdName.trim()) {
    throw new Error('Receiver audio requires an exact local emulator serial and AVD name.');
  }

  const matches = [];
  const visited = new Set();
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      continue;
    }
    for (const entry of entries) {
      const pid = Number(/^pid_(\d+)(?:_info)?\.ini$/.exec(entry.name)?.[1]);
      if (!entry.isFile() || !alive(pid)) continue;
      const file = path.resolve(directory, entry.name);
      if (visited.has(file)) continue;
      visited.add(file);
      let data;
      try {
        data = await readFile(file, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        continue;
      }
      const fields = data.length <= maxDiscoveryBytes ? parseAdvertisement(data) : undefined;
      if (!fields || portNumber(fields.get('port.serial')) !== consolePort ||
        (fields.get('avd.id') ?? fields.get('avd.name')) !== avdName) continue;
      matches.push({ fields, pid });
    }
  }

  if (matches.length > 1) throw new Error('More than one live emulator advertises the selected receiver.');
  if (!matches.length) return;
  const { fields, pid } = matches[0];
  const port = portNumber(fields.get('grpc.port'));
  const token = fields.get('grpc.token');
  if (!port || typeof token !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(token) ||
    fields.has('grpc.server_cert') || fields.has('grpc.ca_root')) return;

  const endpoint = Object.freeze({ serial, avdName, pid, port });
  credentials.set(endpoint, token);
  return endpoint;
}

function readVarint(data, offset) {
  let value = 0n;
  for (let index = 0; index < 10 && offset + index < data.length; index++) {
    const byte = data[offset + index];
    if (index === 9 && byte > 1) break;
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if (byte < 0x80) return { value, end: offset + index + 1 };
  }
  throw new Error('Invalid emulator audio protobuf integer.');
}

function* protobufFields(data) {
  let offset = 0;
  while (offset < data.length) {
    const tag = readVarint(data, offset);
    const field = Number(tag.value >> 3n);
    const type = Number(tag.value & 7n);
    if (field < 1 || field >= (1 << 29)) throw new Error('Invalid emulator audio protobuf field.');
    offset = tag.end;
    if (type === 0) {
      const entry = readVarint(data, offset);
      offset = entry.end;
      yield { field, type, value: entry.value };
      continue;
    }
    let length;
    if (type === 2) {
      const entry = readVarint(data, offset);
      offset = entry.end;
      length = Number(entry.value);
    } else if (type === 1 || type === 5) {
      length = type === 1 ? 8 : 4;
    } else {
      throw new Error('Invalid emulator audio protobuf wire type.');
    }
    if (length > data.length - offset) throw new Error('Truncated emulator audio protobuf field.');
    yield { field, type, value: data.subarray(offset, offset + length) };
    offset += length;
  }
}

function readAudioPacket(data) {
  let pcm;
  let capturedAtUs;
  for (const { field, type, value } of protobufFields(data)) {
    if (field === 1 && type === 2) {
      const format = new Map([...protobufFields(value)].filter((entry) => entry.type === 0)
        .map((entry) => [entry.field, entry.value]));
      if ((format.get(1) ?? 0n) !== BigInt(emulatorAudioFormat.sampleRate) ||
        format.get(2) !== 1n || format.get(3) !== 1n) {
        throw new Error('Emulator audio format does not match the requested 48 kHz S16LE stereo.');
      }
    }
    if (field === 2 && type === 0) capturedAtUs = Number(value);
    if (field === 3 && type === 2) pcm = value;
  }
  if (!pcm || pcm.length % (emulatorAudioFormat.channels * emulatorAudioFormat.sampleBytes) ||
    (capturedAtUs !== undefined && !Number.isSafeInteger(capturedAtUs))) {
    throw new Error('Invalid emulator PCM audio packet.');
  }
  return { pcm, capturedAtUs };
}

export function startEmulatorAudioStream({ endpoint, onSamples, signal, startupTimeoutMs = 5_000 }) {
  const token = credentials.get(endpoint);
  if (!token || !alive(endpoint.pid)) throw new Error('The authenticated receiver audio endpoint is unavailable.');
  if (typeof onSamples !== 'function') throw new TypeError('A receiver audio packet callback is required.');
  signal?.throwIfAborted();

  const ready = Promise.withResolvers();
  const done = Promise.withResolvers();
  // A caller awaiting either promise can still handle the other after a startup failure.
  void ready.promise.catch(() => {});
  void done.promise.catch(() => {});

  const client = connect(`http://127.0.0.1:${endpoint.port}`);
  const rpc = (method) => client.request({
    ':method': 'POST', ':path': `${controllerPath}/${method}`, te: 'trailers',
    'content-type': 'application/grpc', 'grpc-accept-encoding': 'identity',
    authorization: `Bearer ${token}`, [sensitiveHeaders]: ['authorization'],
  });
  const stream = rpc('streamAudio');
  let pending = Buffer.alloc(0);
  let remoteStatus;
  let outcome;
  let failure;

  function admit() {
    if (outcome) return;
    clearTimeout(timer);
    clearTimeout(quietTimer);
    ready.resolve();
  }

  function finish(reason, error) {
    if (!outcome) {
      outcome = reason;
      failure = error;
      clearTimeout(timer);
      clearTimeout(quietTimer);
      if (error) ready.reject(error);
      else if (reason === 'cancelled') ready.reject(new Error('Receiver audio capture was cancelled.'));
      if (!stream.closed) stream.close(constants.NGHTTP2_CANCEL);
      client.destroy();
    }
    return done.promise;
  }

  const cancel = () => finish('cancelled');
  const fail = (message) => finish('failed', new Error(message));
  const timer = setTimeout(() => fail('The receiver emulator did not acknowledge the audio stream.'), startupTimeoutMs);
  timer.unref();
  // EmulatorService writes initial metadata with its first PCM packet. Check the same service's
  // authenticated status on this connection so capture can be armed before any audio plays.
  const quietTimer = setTimeout(() => admitQuietStream(rpc, admit), quietAdmissionMs);
  quietTimer.unref();
  signal?.addEventListener('abort', cancel, { once: true });

  stream.on('response', (headers) => {
    if (!grpcHeaders(headers)) {
      fail('The receiver emulator rejected the audio RPC.');
      return;
    }
    remoteStatus = headers['grpc-status'];
    if (remoteStatus !== undefined && remoteStatus !== '0') {
      fail(`The receiver emulator audio RPC failed (gRPC ${grpcCode(remoteStatus)}).`);
      return;
    }
    admit();
  });
  stream.on('trailers', (headers) => { remoteStatus = headers['grpc-status']; });
  stream.on('data', (bytes) => {
    if (outcome) return;
    pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
    try {
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending[0] !== 0 || length > maxPacketBytes) throw new Error('Invalid emulator audio gRPC frame.');
        if (pending.length < 5 + length) break;
        const packet = readAudioPacket(pending.subarray(5, 5 + length));
        pending = pending.subarray(5 + length);
        if (packet.pcm.length) onSamples(packet);
        if (outcome) break;
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : 'The emulator audio packet could not be processed.');
    }
  });
  stream.on('end', () => {
    if (outcome) return;
    if (remoteStatus !== '0') fail(`The receiver emulator audio RPC ended (gRPC ${grpcCode(remoteStatus)}).`);
    else if (pending.length) fail('The receiver emulator returned a truncated audio frame.');
    else finish('ended');
  });
  stream.on('error', () => fail('The receiver emulator audio stream was interrupted.'));
  client.on('error', () => fail('Could not connect to the receiver emulator audio service.'));
  client.on('close', () => {
    signal?.removeEventListener('abort', cancel);
    clearTimeout(timer);
    clearTimeout(quietTimer);
    if (!outcome) failure = new Error('The receiver emulator audio connection closed unexpectedly.');
    if (failure) {
      ready.reject(failure);
      done.reject(failure);
    } else {
      done.resolve(outcome);
    }
  });

  // AudioFormat fields 1, 2 and 3 set 48000 Hz, stereo and signed 16 bit respectively.
  const format = Buffer.from([0x08, 0x80, 0xf7, 0x02, 0x10, 0x01, 0x18, 0x01]);
  const request = Buffer.alloc(5 + format.length);
  request.writeUInt32BE(format.length, 1);
  format.copy(request, 5);
  stream.end(request);
  return Object.freeze({ ready: ready.promise, done: done.promise, cancel });
}

function grpcHeaders(headers) {
  const type = headers['content-type'];
  return headers[':status'] === 200 && typeof type === 'string' && /^application\/grpc(?:\+|;|$)/.test(type);
}

function admitQuietStream(request, admit) {
  let status;
  try {
    status = request('getStatus');
  } catch {
    return; // The stream's own close/error or startup deadline reports the failure.
  }
  let validResponse = false;
  let code;
  let bytes = 0;
  status.on('response', (headers) => {
    validResponse = grpcHeaders(headers);
    code = headers['grpc-status'];
  });
  status.on('trailers', (headers) => { code = headers['grpc-status']; });
  status.on('data', (data) => { bytes += data.length; });
  status.on('end', () => { if (validResponse && code === '0' && bytes > 5) admit(); });
  status.on('error', () => {});
  status.end(Buffer.alloc(5));
}

function grpcCode(status) {
  return typeof status === 'string' && /^\d{1,2}$/.test(status) ? status : 'missing status';
}
