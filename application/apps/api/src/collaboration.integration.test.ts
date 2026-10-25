import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import * as Y from 'yjs';
import app from './app.js';
import { attachCollaboration } from './collaboration.js';
import { pool } from './db.js';

const server = createServer(app);
attachCollaboration(server);
const address = await new Promise<{ port: number }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address() as { port: number }));
});
const baseUrl = `http://127.0.0.1:${address.port}`;
const sockets: WebSocket[] = [];

after(async () => {
  sockets.forEach((socket) => socket.close());
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

function nextMessage(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Message ${type} non reçu.`)), 5000);
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type === type) { clearTimeout(timer); socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
}

async function connectClient(url: string, cookie: string) {
  const socket = new WebSocket(url, { headers: { cookie } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const initial = await nextMessage(socket, 'sync');
  const document = new Y.Doc();
  Y.applyUpdate(document, Uint8Array.from(Buffer.from(String(initial.update), 'base64')));
  return { socket, document };
}

function insertAtClient(client: { socket: WebSocket; document: Y.Doc }, value: string) {
  const origin = {};
  let update: Uint8Array<ArrayBufferLike> = new Uint8Array();
  client.document.on('update', (change, eventOrigin) => { if (eventOrigin === origin) update = change; });
  client.document.transact(() => client.document.getText('content').insert(0, value), origin);
  client.socket.send(JSON.stringify({ type: 'update', operationId: randomUUID(), update: Buffer.from(update).toString('base64') }));
}

test('Yjs fusionne les éditions simultanées et synchronise le contenu durable', async () => {
  const suffix = randomUUID();
  const identity = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test collaboration', email: `${suffix}@example.test`, password: 'Collab-password-123' }),
  });
  assert.equal(identity.status, 201);
  const cookie = identity.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const created = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'Convergence Yjs' }),
  });
  assert.equal(created.status, 201);
  const document = await created.json() as { id: string };
  const url = `ws://127.0.0.1:${address.port}/ws/documents/${document.id}`;
  const [clientA, clientB] = await Promise.all([connectClient(url, cookie), connectClient(url, cookie)]);
  const acceptedA = nextMessage(clientA.socket, 'accepted');
  const acceptedB = nextMessage(clientB.socket, 'accepted');
  insertAtClient(clientA, 'A');
  insertAtClient(clientB, 'B');
  await Promise.all([acceptedA, acceptedB]);

  const stored = await pool.query('SELECT content, revision FROM documents WHERE id = $1', [document.id]);
  assert.equal(Array.from(stored.rows[0].content as string).sort().join(''), 'AB');
  assert.equal(Number(stored.rows[0].revision), 2);
});
