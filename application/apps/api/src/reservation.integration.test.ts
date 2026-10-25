import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import app from './app.js';
import { bootstrapConfiguredAdmins } from './app.js';
import { pool } from './db.js';

const server = createServer(app);
const address = await new Promise<{ port: number }>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address() as { port: number }));
});
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pool.end();
});

test('les réservations concurrentes ne dépassent jamais la limite et sont idempotentes', async () => {
  const suffix = randomUUID();
  const identityResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test quota', email: `${suffix}@example.test`, password: 'Test-password-123' }),
  });
  assert.equal(identityResponse.status, 201);
  const cookie = identityResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const auth = { 'content-type': 'application/json', cookie };

  const documentResponse = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'Test quota' }),
  });
  const document = await documentResponse.json() as { id: string };
  const limit = 7;
  const linkResponse = await fetch(`${baseUrl}/api/documents/${document.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ limit }),
  });
  const link = await linkResponse.json() as { token: string };

  const attempts = await Promise.all(Array.from({ length: 40 }, (_, index) => fetch(
    `${baseUrl}/api/public/links/${link.token}/reservations`,
    { method: 'POST', headers: { 'idempotency-key': `request-${index}` } },
  )));
  assert.equal(attempts.filter((response) => response.status === 202).length, limit);
  assert.equal(attempts.filter((response) => response.status === 410).length, 40 - limit);

  const duplicateLinkResponse = await fetch(`${baseUrl}/api/documents/${document.id}/links`, {
    method: 'POST', headers: auth, body: JSON.stringify({ limit: 1 }),
  });
  const duplicateLink = await duplicateLinkResponse.json() as { token: string };
  const idem = () => fetch(`${baseUrl}/api/public/links/${duplicateLink.token}/reservations`, {
    method: 'POST', headers: { 'idempotency-key': 'same-request' },
  });
  const [first, second] = await Promise.all([idem(), idem()]);
  assert.deepEqual([first.status, second.status].sort(), [200, 202]);
  const bodies = await Promise.all([first.json(), second.json()]) as Array<{ id: string; replayed: boolean }>;
  assert.equal(bodies[0].id, bodies[1].id);
  assert.equal(bodies.filter((body) => body.replayed).length, 1);
  const state = await pool.query('SELECT remaining FROM download_links WHERE token = $1', [duplicateLink.token]);
  assert.equal(state.rows[0].remaining, 0);
  const notification = await pool.query(
    `SELECT count(*)::int AS count FROM last_copy_notifications n
      JOIN download_links l ON l.id = n.link_id WHERE l.token = $1`, [duplicateLink.token],
  );
  assert.equal(notification.rows[0].count, 1);

  const initialSave = await fetch(`${baseUrl}/api/documents/${document.id}/content`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ content: 'x'.repeat(9600), baseRevision: 0 }),
  });
  assert.equal(initialSave.status, 200);
  const snapshotResponse = await fetch(`${baseUrl}/api/documents/${document.id}/versions`, { method: 'POST', headers: auth });
  assert.equal(snapshotResponse.status, 201);
  const snapshot = await snapshotResponse.json() as { id: string };
  const restoreResponse = await fetch(`${baseUrl}/api/documents/${document.id}/versions/${snapshot.id}/restore`, { method: 'POST', headers: auth });
  assert.equal(restoreResponse.status, 200);
  const [docAResponse, docBResponse] = await Promise.all(['Credit A', 'Credit B'].map((title) => fetch(`${baseUrl}/api/documents`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title }),
  })));
  const [docA, docB] = await Promise.all([docAResponse.json(), docBResponse.json()]) as Array<{ id: string }>;
  const write = (id: string) => fetch(`${baseUrl}/api/documents/${id}/content`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ content: 'y'.repeat(300), baseRevision: 0 }),
  });
  const writes = await Promise.all([write(docA.id), write(docB.id)]);
  assert.deepEqual(writes.map((response) => response.status).sort(), [200, 429]);
  const creditResponse = await fetch(`${baseUrl}/api/credit`, { headers: auth });
  const credit = await creditResponse.json() as { used: number; limit: number };
  assert.equal(credit.used, 9900);
  assert.equal(credit.limit, 10000);
});

test('les sessions protègent les comptes et le tableau de bord administrateur', async () => {
  const anonymous = await fetch(`${baseUrl}/api/documents`);
  assert.equal(anonymous.status, 401);

  const suffix = randomUUID();
  const editorResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rédacteur test', email: `${suffix}@example.test`, password: 'Writer-password-123' }),
  });
  assert.equal(editorResponse.status, 201);
  const editorCookie = editorResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(editorCookie);
  const forbidden = await fetch(`${baseUrl}/api/admin/overview`, { headers: { cookie: editorCookie } });
  assert.equal(forbidden.status, 403);

  process.env.ADMIN_EMAILS = `${suffix}+admin@example.test`;
  process.env.ADMIN_BOOTSTRAP_PASSWORD = 'Admin-password-123';
  await bootstrapConfiguredAdmins();
  const adminResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${suffix}+admin@example.test`, password: 'Admin-password-123' }),
  });
  assert.equal(adminResponse.status, 200);
  const adminCookie = adminResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(adminCookie);
  const allowed = await fetch(`${baseUrl}/api/admin/overview`, { headers: { cookie: adminCookie } });
  assert.equal(allowed.status, 200);
  const editor = await editorResponse.json() as { id: string };
  const blocked = await fetch(`${baseUrl}/api/admin/people/${editor.id}/blocks`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ reason: 'Test de suspension', durationHours: 1 }),
  });
  assert.equal(blocked.status, 201);
  const blockedCreate = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: editorCookie },
    body: JSON.stringify({ title: 'Doit être refusé' }),
  });
  assert.equal(blockedCreate.status, 403);
});
