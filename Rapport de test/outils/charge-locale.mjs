import { randomUUID } from 'node:crypto';
import WebSocket from '../../application/node_modules/ws/wrapper.mjs';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const count = Number(process.env.HTTP_REQUESTS ?? 1000);
const concurrency = Number(process.env.HTTP_CONCURRENCY ?? 40);
const socketCount = Number(process.env.WS_CLIENTS ?? 300);
const tag = randomUUID();

async function post(path, body, cookie) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  return { response, data };
}

function percentile(sorted, p) {
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)].toFixed(1));
}

async function measureReads(name, url) {
  let next = 0;
  const samples = [];
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= count) return;
      const started = performance.now();
      try {
        const response = await fetch(url);
        await response.arrayBuffer();
        samples.push({ ms: performance.now() - started, status: response.status });
      } catch (error) {
        samples.push({ ms: performance.now() - started, status: 0, error: String(error) });
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = performance.now() - started;
  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const sample of samples) statuses[sample.status] = (statuses[sample.status] ?? 0) + 1;
  return {
    scenario: name,
    requests: count,
    concurrency,
    elapsed_ms: Number(elapsed.toFixed(1)),
    requests_per_second: Number((count / (elapsed / 1000)).toFixed(1)),
    latency_ms: { p50: percentile(sorted, 0.50), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) },
    statuses,
  };
}

async function connectAndSync(url, cookie, index) {
  const started = performance.now();
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers: { cookie } });
    let completed = false;
    const finish = (success, error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({ socket, success, error, ms: performance.now() - started });
    };
    const timer = setTimeout(() => {
      finish(false, 'timeout');
      socket.terminate();
    }, 20000);
    socket.once('open', () => socket.once('message', (buffer) => {
      try {
        const message = JSON.parse(buffer.toString());
        finish(message.type === 'sync', message.type === 'sync' ? undefined : `unexpected:${message.type}`);
      } catch (error) {
        finish(false, String(error));
      }
    }));
    socket.once('error', (error) => finish(false, String(error)));
    socket.testIndex = index;
  });
}

const account = await post('/api/auth/register', {
  name: 'Preuve de charge locale',
  email: `${tag}@example.test`,
  password: 'Load-test-password-123',
});
const cookie = account.response.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Cookie de session absent.');
const document = await post('/api/documents', { title: 'Charge locale — document isolé' }, cookie);
const link = await post(`/api/documents/${document.data.id}/links`, { limit: 10000 }, cookie);

const http = [
  await measureReads('health', `${base}/health`),
  await measureReads('public_link_read', `${base}/api/public/links/${link.data.token}`),
];
if (http.some((scenario) => scenario.statuses['200'] !== count || Object.keys(scenario.statuses).length !== 1)) {
  throw new Error(`Une ou plusieurs réponses HTTP sont en échec : ${JSON.stringify(http)}`);
}

const websocketUrl = base.replace(/^http/, 'ws') + `/ws/documents/${document.data.id}`;
const socketStarted = performance.now();
const outcomes = await Promise.all(Array.from({ length: socketCount }, (_, index) => connectAndSync(websocketUrl, cookie, index)));
const socketElapsed = performance.now() - socketStarted;
const successful = outcomes.filter((outcome) => outcome.success);
const latencies = outcomes.map((outcome) => outcome.ms).sort((a, b) => a - b);
const websocket = {
  scenario: 'simultaneous_initial_sync',
  connections_requested: socketCount,
  initial_sync_received: successful.length,
  failures: outcomes.length - successful.length,
  elapsed_ms: Number(socketElapsed.toFixed(1)),
  connections_per_second: Number((socketCount / (socketElapsed / 1000)).toFixed(1)),
  latency_ms: { p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) },
  identity_count: 1,
  failure_samples: outcomes.filter((outcome) => !outcome.success).slice(0, 5).map(({ error }) => error),
};
await Promise.all(outcomes.map(({ socket }) => new Promise((resolve) => {
  if (socket.readyState === WebSocket.CLOSED) return resolve();
  socket.once('close', resolve);
  socket.close();
  setTimeout(() => { socket.terminate(); resolve(); }, 1000);
})));
if (websocket.failures > 0) throw new Error(`Échecs WebSocket : ${JSON.stringify(websocket)}`);

console.log(JSON.stringify({
  date: new Date().toISOString(),
  target: base,
  test_data: 'Un compte, un document et un lien isolés; aucune réservation de téléchargement.',
  http,
  websocket,
}, null, 2));
