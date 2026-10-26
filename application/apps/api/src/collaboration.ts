import crypto from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PoolClient } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { inTransaction, pool } from './db.js';
import { publishRealtimeEvent, startRealtimeBus } from './realtime.js';
import { recordCreditAbuse } from './abuse.js';

const wsServer = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
const allowedWebOrigins = (process.env.WEB_ORIGINS ?? process.env.WEB_ORIGIN ?? 'http://localhost:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
type User = { id: string; name: string };
type Room = { document: Y.Doc; awareness: Awareness; clients: Set<{ socket: WebSocket; user: User; awarenessIds: Set<number> }> };
const rooms = new Map<string, Promise<Room>>();
const publicLinkSockets = new Map<string, Set<WebSocket>>();

function reject(socket: Duplex, status: number, message: string) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function sessionCookie(request: IncomingMessage) {
  const value = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('journal_session='));
  return value ? decodeURIComponent(value.slice('journal_session='.length)) : undefined;
}

async function authenticate(request: IncomingMessage, documentId: string): Promise<User | null> {
  const token = sessionCookie(request);
  if (!token) return null;
  const session = await pool.query(
    `SELECT p.id, p.name FROM sessions s JOIN people p ON p.id = s.person_id
      JOIN document_members m ON m.person_id = p.id
     WHERE s.id_hash = $1 AND s.expires_at > now() AND m.document_id = $2`,
    [crypto.createHash('sha256').update(token).digest('hex'), documentId],
  );
  if (!session.rowCount) return null;
  const block = await pool.query(
    'SELECT 1 FROM temporary_blocks WHERE person_id = $1 AND starts_at <= now() AND ends_at > now() LIMIT 1',
    [session.rows[0].id],
  );
  return block.rowCount ? null : session.rows[0] as User;
}

async function getRoom(documentId: string): Promise<Room> {
  const pending = rooms.get(documentId);
  if (pending) return pending;
  const roomPromise = (async () => {
    const initialState = await inTransaction(async (client) => {
      const stored = await client.query('SELECT content FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
      if (!stored.rowCount) throw new Error('Document introuvable.');
      const current = await client.query('SELECT state_update FROM document_yjs_state WHERE document_id = $1', [documentId]);
      if (current.rowCount) return new Uint8Array(current.rows[0].state_update as Buffer);
      const initial = new Y.Doc();
      if (stored.rows[0].content) initial.getText('content').insert(0, stored.rows[0].content as string);
      const state = Y.encodeStateAsUpdate(initial);
      await client.query('INSERT INTO document_yjs_state (document_id, state_update) VALUES ($1, $2)', [documentId, Buffer.from(state)]);
      initial.destroy();
      return state;
    });
    const document = new Y.Doc();
    Y.applyUpdate(document, initialState);
    const awareness = new Awareness(document);
    awareness.setLocalState(null);
    const room: Room = { document, awareness, clients: new Set<{ socket: WebSocket; user: User; awarenessIds: Set<number> }>() };
    awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      if (!changed.length) return;
      const encoded = Buffer.from(encodeAwarenessUpdate(awareness, changed)).toString('base64');
      for (const client of room.clients) if (client.socket !== origin) send(client.socket, { type: 'awareness', update: encoded });
      if (origin !== 'redis') void publishRealtimeEvent('document-awareness', { documentId, update: encoded });
      presence(room);
    });
    return room;
  })();
  rooms.set(documentId, roomPromise);
  try { return await roomPromise; }
  catch (error) { rooms.delete(documentId); throw error; }
}

function send(socket: WebSocket, message: object) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function presence(room: Room) {
  const users = [...new Set([...room.awareness.getStates().values()]
    .map((state) => (state as { user?: { name?: string } }).user?.name)
    .filter((name): name is string => Boolean(name)))];
  for (const { socket } of room.clients) send(socket, { type: 'presence', users });
}

export async function updateCollaborativeText(client: PoolClient, documentId: string, previous: string, next: string) {
  const current = await client.query('SELECT state_update FROM document_yjs_state WHERE document_id = $1 FOR UPDATE', [documentId]);
  const document = new Y.Doc();
  if (current.rowCount) Y.applyUpdate(document, new Uint8Array(current.rows[0].state_update as Buffer));
  else if (previous) document.getText('content').insert(0, previous);
  const text = document.getText('content');
  const before = Array.from(text.toString());
  const after = Array.from(next);
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const offset = before.slice(0, prefix).join('').length;
  const removed = before.slice(prefix, before.length - suffix).join('').length;
  const inserted = after.slice(prefix, after.length - suffix).join('');
  document.transact(() => {
    if (removed) text.delete(offset, removed);
    if (inserted) text.insert(offset, inserted);
  }, 'http');
  const update = Y.encodeStateAsUpdate(document);
  await client.query(
    `INSERT INTO document_yjs_state (document_id, state_update) VALUES ($1, $2)
     ON CONFLICT (document_id) DO UPDATE SET state_update = EXCLUDED.state_update, updated_at = now()`,
    [documentId, Buffer.from(update)],
  );
  document.destroy();
  return update;
}

export async function restoreCollaborativeText(client: PoolClient, documentId: string, currentContent: string, restoredContent: string, versionState: Buffer | null) {
  const current = await client.query('SELECT state_update FROM document_yjs_state WHERE document_id = $1 FOR UPDATE', [documentId]);
  const document = new Y.Doc();
  if (current.rowCount) Y.applyUpdate(document, new Uint8Array(current.rows[0].state_update as Buffer));
  else if (currentContent) document.getText('content').insert(0, currentContent);
  const text = document.getText('content');
  if (versionState) {
    const historical = new Y.Doc();
    Y.applyUpdate(historical, new Uint8Array(versionState));
    const delta = historical.getText('content').toDelta();
    document.transact(() => {
      if (text.length) text.delete(0, text.length);
      text.applyDelta(delta);
    }, 'restore');
    historical.destroy();
  } else {
    const currentText = text.toString();
    const before = Array.from(currentText);
    const after = Array.from(restoredContent);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const offset = before.slice(0, prefix).join('').length;
    const removed = before.slice(prefix, before.length - suffix).join('').length;
    const inserted = after.slice(prefix, after.length - suffix).join('');
    document.transact(() => {
      if (removed) text.delete(offset, removed);
      if (inserted) text.insert(offset, inserted);
    }, 'restore');
  }
  const update = Y.encodeStateAsUpdate(document);
  await client.query(
    `INSERT INTO document_yjs_state (document_id, state_update) VALUES ($1, $2)
     ON CONFLICT (document_id) DO UPDATE SET state_update = EXCLUDED.state_update, updated_at = now()`,
    [documentId, Buffer.from(update)],
  );
  document.destroy();
  return update;
}

export async function broadcastDocumentUpdate(documentId: string, update: Uint8Array, revision: number) {
  const pending = rooms.get(documentId);
  if (pending) {
    const room = await pending;
    Y.applyUpdate(room.document, update);
    const encoded = Buffer.from(update).toString('base64');
    for (const { socket } of room.clients) send(socket, { type: 'update', update: encoded, revision });
  }
  void publishRealtimeEvent('document-update', { documentId });
}

export function notifyLinkExhausted(token: string) {
  for (const socket of publicLinkSockets.get(token) ?? []) send(socket, { type: 'link-exhausted' });
  void publishRealtimeEvent('link-exhausted', { token });
}

async function acceptUpdate(documentId: string, user: User, operationId: string, update: Uint8Array) {
  return inTransaction(async (client) => {
    const blocked = await client.query('SELECT 1 FROM temporary_blocks WHERE person_id = $1 AND starts_at <= now() AND ends_at > now() LIMIT 1', [user.id]);
    if (blocked.rowCount) throw new Error('Votre compte est temporairement bloqué pour activité abusive.');
    const locked = await client.query('SELECT title, content FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
    if (!locked.rowCount) throw new Error('Document introuvable.');
    const duplicate = await client.query(
      'SELECT 1 FROM collaboration_operations WHERE document_id = $1 AND operation_id = $2',
      [documentId, operationId],
    );
    if (duplicate.rowCount) {
      const latest = await client.query(
        `SELECT d.revision::int AS revision, y.state_update,
                COALESCE(c.used_chars, 0)::int AS used, COALESCE(c.limit_chars, 10000)::int AS limit
           FROM documents d LEFT JOIN document_yjs_state y ON y.document_id = d.id
           LEFT JOIN daily_credits c ON c.person_id = $2 AND c.period = CURRENT_DATE
          WHERE d.id = $1`, [documentId, user.id],
      );
      const row = latest.rows[0];
      return { revision: row.revision, update: row.state_update ? new Uint8Array(row.state_update) : new Uint8Array(), used: row.used, limit: row.limit };
    }
    const currentState = await client.query('SELECT state_update FROM document_yjs_state WHERE document_id = $1', [documentId]);
    const staged = new Y.Doc();
    if (currentState.rowCount) Y.applyUpdate(staged, new Uint8Array(currentState.rows[0].state_update as Buffer));
    else if (locked.rows[0].content) staged.getText('content').insert(0, locked.rows[0].content as string);
    let insertedCharacters = 0;
    const sharedText = staged.getText('content');
    const observer = (event: Y.YTextEvent) => {
      for (const item of event.changes.delta) {
        if (typeof item.insert === 'string') insertedCharacters += Array.from(item.insert).length;
      }
    };
    sharedText.observe(observer);
    Y.applyUpdate(staged, update, 'client');
    sharedText.unobserve(observer);
    if (insertedCharacters > 0) {
      if (insertedCharacters > 10000) throw new Error('Une opération dépasse le crédit quotidien.');
      const charged = await client.query(
        `INSERT INTO daily_credits (person_id, period, used_chars, limit_chars)
         VALUES ($1, CURRENT_DATE, $2, 10000)
         ON CONFLICT (person_id, period) DO UPDATE
           SET used_chars = daily_credits.used_chars + EXCLUDED.used_chars
         WHERE daily_credits.used_chars + EXCLUDED.used_chars <= daily_credits.limit_chars
         RETURNING used_chars, limit_chars`, [user.id, insertedCharacters],
      );
      if (!charged.rowCount) throw new Error('Votre crédit quotidien est épuisé.');
    }
    await client.query('INSERT INTO collaboration_operations (document_id, operation_id, person_id) VALUES ($1, $2, $3)', [documentId, operationId, user.id]);
    const content = sharedText.toString();
    const updated = await client.query(
      `UPDATE documents SET content = $2, revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING revision::int AS revision`, [documentId, content],
    );
    const stateUpdate = Y.encodeStateAsUpdate(staged);
    await client.query(
      `INSERT INTO document_yjs_state (document_id, state_update, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (document_id) DO UPDATE SET state_update = EXCLUDED.state_update, updated_at = now()`,
      [documentId, Buffer.from(stateUpdate)],
    );
    const credit = await client.query('SELECT used_chars, limit_chars FROM daily_credits WHERE person_id = $1 AND period = CURRENT_DATE', [user.id]);
    return {
      revision: updated.rows[0].revision,
      update: stateUpdate,
      used: Number(credit.rows[0]?.used_chars ?? 0),
      limit: Number(credit.rows[0]?.limit_chars ?? 10000),
    };
  });
}

async function connect(socket: WebSocket, documentId: string, user: User) {
  const room = await getRoom(documentId);
  const client = { socket, user, awarenessIds: new Set<number>() };
  room.clients.add(client);
  socket.on('error', (error) => console.error('Erreur WebSocket collaborative.', error));
  send(socket, {
    type: 'sync',
    update: Buffer.from(Y.encodeStateAsUpdate(room.document)).toString('base64'),
  });
  const awarenessIds = [...room.awareness.getStates().keys()].filter((id) => id !== room.document.clientID);
  if (awarenessIds.length) send(socket, { type: 'awareness', update: Buffer.from(encodeAwarenessUpdate(room.awareness, awarenessIds)).toString('base64') });
  presence(room);
  void publishRealtimeEvent('document-awareness-request', { documentId });
  socket.on('message', (raw) => {
    void (async () => {
      const message = JSON.parse(raw.toString()) as { type?: string; operationId?: string; update?: string };
      if (message.type === 'awareness' && message.update) {
        const bytes = new Uint8Array(Buffer.from(message.update, 'base64'));
        if (bytes.length > 64_000) return;
        const ids = decodeAwarenessIds(bytes);
        if (ids.some((id) => [...room.clients].some((other) => other !== client && other.awarenessIds.has(id)))) return;
        ids.forEach((id) => client.awarenessIds.add(id));
        applyAwarenessUpdate(room.awareness, bytes, socket);
        return;
      }
      if (message.type !== 'update' || !message.operationId || !message.update || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.operationId)) return;
      const update = Buffer.from(message.update, 'base64');
      if (update.length > 900_000) throw new Error('Mise à jour trop volumineuse.');
      const accepted = await acceptUpdate(documentId, user, message.operationId, new Uint8Array(update));
      Y.applyUpdate(room.document, accepted.update);
      const encoded = Buffer.from(accepted.update).toString('base64');
      for (const participant of room.clients) {
        send(participant.socket, { type: 'update', update: encoded, revision: accepted.revision });
        if (participant === client) send(participant.socket, {
          type: 'accepted', revision: accepted.revision,
          used: accepted.used, remaining: Math.max(0, accepted.limit - accepted.used),
        });
      }
    })().catch(async (error: Error) => {
      const abuse = /crédit quotidien|dépasse le crédit quotidien/i.test(error.message) ? await recordCreditAbuse(user.id, error.message) : undefined;
      send(socket, { type: 'error', code: abuse?.blocked ? 'ACCOUNT_BLOCKED' : undefined, message: abuse?.blocked ? 'Compte temporairement bloqué après plusieurs tentatives de dépassement du crédit.' : error.message });
    });
  });
  socket.on('close', () => {
    if (client.awarenessIds.size) removeAwarenessStates(room.awareness, [...client.awarenessIds], socket);
    room.clients.delete(client);
    presence(room);
    if (!room.clients.size) {
      setTimeout(() => {
        const pending = rooms.get(documentId);
        if (!room.clients.size && pending) {
          rooms.delete(documentId);
          void pending.then(({ document }) => document.destroy());
        }
      }, 30_000).unref();
    }
  });
}

function decodeAwarenessIds(update: Uint8Array): number[] {
  let offset = 0;
  const read = () => {
    let value = 0; let multiplier = 1;
    while (offset < update.length) { const byte = update[offset++]; value += (byte & 0x7f) * multiplier; if (byte < 0x80) return value; multiplier *= 128; if (multiplier > 2 ** 49) break; }
    throw new Error('État de présence invalide.');
  };
  const count = read();
  if (count > 20) throw new Error('Trop d’états de présence.');
  const ids: number[] = [];
  for (let index = 0; index < count; index++) { ids.push(read()); read(); const length = read(); offset += length; if (offset > update.length) throw new Error('État de présence invalide.'); }
  if (offset !== update.length) throw new Error('État de présence invalide.');
  return ids;
}

export function attachCollaboration(server: Server) {
  void startRealtimeBus(async (event) => {
    if (event.type === 'link-exhausted') {
      const token = String(event.payload.token ?? '');
      for (const socket of publicLinkSockets.get(token) ?? []) send(socket, { type: 'link-exhausted' });
      return;
    }
    const documentId = String(event.payload.documentId ?? '');
    const pending = rooms.get(documentId);
    if (!pending) return;
    const room = await pending;
    if (event.type === 'document-awareness-request') {
      const ids = [...room.awareness.getStates().keys()].filter((id) => id !== room.document.clientID);
      if (ids.length) void publishRealtimeEvent('document-awareness', { documentId, update: Buffer.from(encodeAwarenessUpdate(room.awareness, ids)).toString('base64') }, event.origin);
    } else if (event.type === 'document-awareness' && typeof event.payload.update === 'string') {
      applyAwarenessUpdate(room.awareness, new Uint8Array(Buffer.from(event.payload.update, 'base64')), 'redis');
    } else if (event.type === 'document-update') {
      const result = await pool.query('SELECT y.state_update, d.revision::int AS revision FROM document_yjs_state y JOIN documents d ON d.id = y.document_id WHERE y.document_id = $1', [documentId]);
      if (!result.rowCount) return;
      const update = new Uint8Array(result.rows[0].state_update as Buffer);
      Y.applyUpdate(room.document, update);
      const encoded = Buffer.from(Y.encodeStateAsUpdate(room.document)).toString('base64');
      for (const participant of room.clients) send(participant.socket, { type: 'update', update: encoded, revision: result.rows[0].revision });
    }
  });
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const publicMatch = url.pathname.match(/^\/ws\/public\/links\/([A-Za-z0-9_-]{20,100})$/);
      if (publicMatch) {
        const origin = request.headers.origin;
        if (origin && !allowedWebOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');
        const token = publicMatch[1];
        const link = await pool.query("SELECT state, remaining, expires_at FROM download_links WHERE token = $1", [token]);
        if (!link.rowCount) return reject(socket, 404, 'Not Found');
        wsServer.handleUpgrade(request, socket, head, (websocket) => {
          const expired = link.rows[0].expires_at && new Date(link.rows[0].expires_at) <= new Date();
          if (link.rows[0].state !== 'ACTIVE' || Number(link.rows[0].remaining) <= 0 || expired) {
            send(websocket, { type: 'link-exhausted' });
            websocket.close(1000, 'Lien épuisé ou expiré');
            return;
          }
          const subscribers = publicLinkSockets.get(token) ?? new Set<WebSocket>();
          subscribers.add(websocket); publicLinkSockets.set(token, subscribers);
          websocket.on('close', () => { subscribers.delete(websocket); if (!subscribers.size) publicLinkSockets.delete(token); });
          websocket.on('error', (error) => console.error('WebSocket visiteur.', error));
        });
        return;
      }
      const match = url.pathname.match(/^\/ws\/documents\/([0-9a-f-]{36})$/i);
      if (!match) return reject(socket, 404, 'Not Found');
      const origin = request.headers.origin;
      if (origin && !allowedWebOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');
      const documentId = match[1];
      const user = await authenticate(request, documentId);
      if (!user) return reject(socket, 401, 'Unauthorized');
      wsServer.handleUpgrade(request, socket, head, (websocket) => { void connect(websocket, documentId, user); });
    })().catch((error) => {
      console.error('Connexion collaborative refusée.', error);
      reject(socket, 500, 'Internal Server Error');
    });
  });
}

export async function getActiveCollaborativeDocuments() {
  const activeRooms = await Promise.all([...rooms.entries()].map(async ([documentId, pending]) => {
    const room = await pending;
    const editors = [...new Map([...room.clients].map(({ user }) => [user.id, user.name])).values()];
    return { documentId, editors };
  }));
  const connected = activeRooms.filter((room) => room.editors.length > 0);
  if (!connected.length) return [];

  const documents = await pool.query(
    `SELECT id, title, revision::int AS revision, updated_at
       FROM documents WHERE id = ANY($1::uuid[]) ORDER BY title`,
    [connected.map((room) => room.documentId)],
  );
  const editorsByDocument = new Map(connected.map((room) => [room.documentId, room.editors]));
  return documents.rows.map((document) => ({
    ...document,
    editors: editorsByDocument.get(document.id) ?? [],
  }));
}
