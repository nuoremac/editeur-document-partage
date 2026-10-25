import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import path from 'node:path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { pool, inTransaction } from './db.js';
import { broadcastDocumentUpdate, restoreCollaborativeText, updateCollaborativeText } from './collaboration.js';
import { HttpError } from './errors.js';

const app = express();
const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'journal_session';
const SESSION_DAYS = 14;
app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  const origin = req.header('origin');
  if (origin && origin !== (process.env.WEB_ORIGIN ?? 'http://localhost:5173')) {
    next(new HttpError(403, 'Origine de requête non autorisée.', 'ORIGIN_FORBIDDEN'));
    return;
  }
  next();
});

const personSchema = z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email().max(320) });
const documentSchema = z.object({ title: z.string().trim().min(1).max(200) });
const shareSchema = z.object({ email: z.string().trim().email(), role: z.enum(['EDITOR']).default('EDITOR') });
const linkSchema = z.object({ limit: z.number().int().positive().max(100_000), expiresAt: z.string().datetime().optional() });
const contentSchema = z.object({ content: z.string().max(1_000_000), baseRevision: z.number().int().nonnegative() });
const authSchema = personSchema.extend({ password: z.string().min(10).max(200) });
const loginSchema = z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(200) });
const blockSchema = z.object({ reason: z.string().trim().min(3).max(500), durationHours: z.number().int().positive().max(24 * 90) });

function asyncRoute(handler: express.RequestHandler): express.RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function cookieValue(req: express.Request, name: string): string | undefined {
  const cookies = req.headers.cookie?.split(';') ?? [];
  const entry = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : undefined;
}

async function signedIn(req: express.Request) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) throw new HttpError(401, 'Connectez-vous pour continuer.', 'AUTH_REQUIRED');
  const result = await pool.query(
    `SELECT p.id, p.name, p.email, p.account_role AS role
       FROM sessions s JOIN people p ON p.id = s.person_id
      WHERE s.id_hash = $1 AND s.expires_at > now()`,
    [crypto.createHash('sha256').update(token).digest('hex')],
  );
  if (!result.rowCount) throw new HttpError(401, 'Votre session a expiré. Connectez-vous à nouveau.', 'SESSION_EXPIRED');
  return result.rows[0] as { id: string; name: string; email: string; role: 'EDITOR' | 'ADMIN' };
}

function requireAdmin(person: { role: string }) {
  if (person.role !== 'ADMIN') throw new HttpError(403, 'Réservé à l’administrateur.', 'ADMIN_REQUIRED');
}

async function createSession(personId: string, res: express.Response) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query('INSERT INTO sessions (id_hash, person_id, expires_at) VALUES ($1, $2, $3)', [
    crypto.createHash('sha256').update(token).digest('hex'), personId, expires,
  ]);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`);
}

async function requireNotBlocked(personId: string) {
  const result = await pool.query(
    'SELECT 1 FROM temporary_blocks WHERE person_id = $1 AND starts_at <= now() AND ends_at > now() LIMIT 1',
    [personId],
  );
  if (result.rowCount) throw new HttpError(403, 'Votre compte est temporairement suspendu.', 'ACCOUNT_BLOCKED');
}

async function requireMember(documentId: string, personId: string, minimum: 'EDITOR' | 'OWNER' = 'EDITOR') {
  const result = await pool.query(
    `SELECT role FROM document_members WHERE document_id = $1 AND person_id = $2`,
    [documentId, personId],
  );
  const role = result.rows[0]?.role as string | undefined;
  if (!role || (minimum === 'OWNER' && role !== 'OWNER')) {
    throw new HttpError(403, 'Vous n’avez pas accès à ce document.', 'FORBIDDEN');
  }
}

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const input = authSchema.parse(req.body);
  const email = input.email.toLowerCase();
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(input.password, salt, 64) as Buffer;
  const passwordHash = `${salt}:${derived.toString('hex')}`;
  const result = await pool.query(
    `INSERT INTO people (name, email, password_hash, account_role) VALUES ($1, $2, $3, 'EDITOR')
     RETURNING id, name, email, account_role AS role`,
    [input.name, email, passwordHash],
  );
  await createSession(result.rows[0].id, res);
  res.status(201).json(result.rows[0]);
}));

export async function bootstrapConfiguredAdmins() {
  const emails = (process.env.ADMIN_EMAILS ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!emails.length) return;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? '';
  if (password.length < 12) throw new Error('ADMIN_BOOTSTRAP_PASSWORD doit contenir au moins 12 caractères lorsque ADMIN_EMAILS est configuré.');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64) as Buffer;
  const passwordHash = `${salt}:${derived.toString('hex')}`;
  for (const email of emails) {
    const name = email.split('@')[0].replace(/[._+-]+/g, ' ').slice(0, 100) || 'Administrateur';
    await pool.query(
      `INSERT INTO people (name, email, password_hash, account_role)
       VALUES ($1, $2, $3, 'ADMIN')
       ON CONFLICT (email) DO UPDATE SET account_role = 'ADMIN',
         password_hash = COALESCE(people.password_hash, EXCLUDED.password_hash)`,
      [name, email, passwordHash],
    );
  }
}

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const input = loginSchema.parse(req.body);
  const result = await pool.query('SELECT id, name, email, password_hash, account_role AS role FROM people WHERE email = lower($1)', [input.email]);
  const row = result.rows[0];
  if (!row?.password_hash) throw new HttpError(401, 'E-mail ou mot de passe incorrect.', 'INVALID_CREDENTIALS');
  const [salt, expectedHex] = String(row.password_hash).split(':');
  const actual = await scrypt(input.password, salt, 64) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'E-mail ou mot de passe incorrect.', 'INVALID_CREDENTIALS');
  }
  await pool.query('DELETE FROM sessions WHERE person_id = $1', [row.id]);
  await createSession(row.id, res);
  res.json({ id: row.id, name: row.name, email: row.email, role: row.role });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await pool.query('DELETE FROM sessions WHERE id_hash = $1', [crypto.createHash('sha256').update(token).digest('hex')]);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.status(204).end();
}));

app.get('/api/auth/me', asyncRoute(async (req, res) => {
  res.json(await signedIn(req));
}));

app.post('/api/documents', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireNotBlocked(personId);
  const input = documentSchema.parse(req.body);
  const document = await inTransaction(async (client) => {
    const created = await client.query(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2)
       RETURNING id, title, content, revision::int AS revision, created_at, updated_at`,
      [input.title, personId],
    );
    await client.query(
      `INSERT INTO document_members (document_id, person_id, role) VALUES ($1, $2, 'OWNER')`,
      [created.rows[0].id, personId],
    );
    return created.rows[0];
  });
  res.status(201).json(document);
}));

app.get('/api/documents', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  const result = await pool.query(
    `SELECT d.id, d.title, d.revision::int AS revision, d.updated_at, m.role
       FROM documents d JOIN document_members m ON m.document_id = d.id
      WHERE m.person_id = $1 ORDER BY d.updated_at DESC`,
    [personId],
  );
  res.json({ documents: result.rows });
}));

app.get('/api/documents/:documentId', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireMember(String(req.params.documentId), personId);
  const result = await pool.query(
    `SELECT d.id, d.title, d.content, d.revision::int AS revision, d.created_at, d.updated_at, m.role
       FROM documents d JOIN document_members m ON m.document_id = d.id
      WHERE d.id = $1 AND m.person_id = $2`,
    [String(req.params.documentId), personId],
  );
  if (!result.rowCount) throw new HttpError(404, 'Document introuvable.', 'NOT_FOUND');
  res.json(result.rows[0]);
}));

app.put('/api/documents/:documentId/content', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireNotBlocked(personId);
  const input = contentSchema.parse(req.body);
  await requireMember(String(req.params.documentId), personId);
  const saved = await inTransaction(async (client) => {
    const docResult = await client.query(
      'SELECT id, title, content, revision FROM documents WHERE id = $1 FOR UPDATE',
      [String(req.params.documentId)],
    );
    if (!docResult.rowCount) throw new HttpError(404, 'Document introuvable.', 'NOT_FOUND');
    const previous = docResult.rows[0];
    if (Number(previous.revision) !== input.baseRevision) {
      throw new HttpError(409, 'Le document a changé depuis son chargement. Rechargez-le avant de réessayer.', 'REVISION_CONFLICT');
    }
    const before = Array.from(previous.content as string);
    const after = Array.from(input.content);
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
    let suffix = 0;
    while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
    const inserted = after.length - prefix - suffix;
    if (inserted > 0) {
      if (inserted > 10000) throw new HttpError(429, 'Cette modification dépasse le crédit quotidien.', 'CREDIT_EXHAUSTED');
      const charged = await client.query(
        `INSERT INTO daily_credits (person_id, period, used_chars, limit_chars)
         VALUES ($1, CURRENT_DATE, $2, 10000)
         ON CONFLICT (person_id, period) DO UPDATE
           SET used_chars = daily_credits.used_chars + EXCLUDED.used_chars
         WHERE daily_credits.used_chars + EXCLUDED.used_chars <= daily_credits.limit_chars
         RETURNING used_chars, limit_chars`,
        [personId, inserted],
      );
      if (!charged.rowCount) throw new HttpError(429, 'Votre crédit quotidien est épuisé.', 'CREDIT_EXHAUSTED');
    }
    const updated = await client.query(
      `UPDATE documents SET content = $2, revision = revision + 1, updated_at = now()
        WHERE id = $1 AND revision = $3
        RETURNING id, title, content, revision::int AS revision, updated_at`,
      [String(req.params.documentId), input.content, input.baseRevision],
    );
    const result = updated.rows[0];
    await client.query(
      `INSERT INTO document_versions (document_id, revision, title, content, created_by)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (document_id, revision) DO NOTHING`,
      [result.id, result.revision, result.title, result.content, personId],
    );
    const credit = await client.query(
      `SELECT used_chars, limit_chars FROM daily_credits WHERE person_id = $1 AND period = CURRENT_DATE`,
      [personId],
    );
    const collaborativeUpdate = await updateCollaborativeText(client, String(req.params.documentId), previous.content as string, input.content);
    await client.query(
      'UPDATE document_versions SET state_update = $3 WHERE document_id = $1 AND revision = $2',
      [result.id, result.revision, Buffer.from(collaborativeUpdate)],
    );
    return { ...result, insertedCharacters: inserted, credit: credit.rows[0] ?? { used_chars: 0, limit_chars: 10000 }, collaborativeUpdate };
  });
  const { collaborativeUpdate, ...response } = saved;
  await broadcastDocumentUpdate(String(req.params.documentId), collaborativeUpdate, response.revision);
  res.json(response);
}));

app.get('/api/credit', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  const result = await pool.query(
    `SELECT used_chars, limit_chars FROM daily_credits WHERE person_id = $1 AND period = CURRENT_DATE`,
    [personId],
  );
  const credit = result.rows[0] ?? { used_chars: 0, limit_chars: 10000 };
  res.json({ used: credit.used_chars, limit: credit.limit_chars, remaining: credit.limit_chars - credit.used_chars });
}));

app.get('/api/notifications', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const result = await pool.query(
    `SELECT n.id, 'LAST_COPY'::text AS type, 'Lien de téléchargement épuisé'::text AS title,
            'Le quota de téléchargement de « ' || d.title || ' » a atteint zéro.' AS message,
            n.created_at, n.state
       FROM last_copy_notifications n
       JOIN download_links l ON l.id = n.link_id
       JOIN documents d ON d.id = l.document_id
      WHERE lower(n.recipient_email) = lower($1)
      ORDER BY n.created_at DESC LIMIT 50`,
    [user.email],
  );
  res.json({ notifications: result.rows });
}));

app.post('/api/documents/:documentId/share', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireNotBlocked(personId);
  const input = shareSchema.parse(req.body);
  await requireMember(String(req.params.documentId), personId, 'OWNER');
  const person = await pool.query('SELECT id FROM people WHERE email = lower($1)', [input.email]);
  if (!person.rowCount) throw new HttpError(404, 'Cette personne doit d’abord s’identifier.', 'PERSON_NOT_FOUND');
  await pool.query(
    `INSERT INTO document_members (document_id, person_id, role) VALUES ($1, $2, 'EDITOR')
     ON CONFLICT (document_id, person_id) DO UPDATE SET role = 'EDITOR'`,
    [String(req.params.documentId), person.rows[0].id],
  );
  res.status(204).end();
}));

app.post('/api/documents/:documentId/versions', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireNotBlocked(personId);
  await requireMember(String(req.params.documentId), personId);
  const version = await inTransaction(async (client) => {
    const document = await client.query(
      'SELECT id, title, content, revision FROM documents WHERE id = $1 FOR UPDATE',
      [String(req.params.documentId)],
    );
    if (!document.rowCount) throw new HttpError(404, 'Document introuvable.', 'NOT_FOUND');
    const row = document.rows[0];
    const saved = await client.query(
      `INSERT INTO document_versions (document_id, revision, title, content, state_update, created_by)
       VALUES ($1, $2, $3, $4, (SELECT state_update FROM document_yjs_state WHERE document_id = $1), $5)
       ON CONFLICT (document_id, revision) DO UPDATE SET created_at = now()
       RETURNING id, document_id, revision, title, created_at`,
      [row.id, row.revision, row.title, row.content, personId],
    );
    return saved.rows[0];
  });
  res.status(201).json(version);
}));

app.get('/api/documents/:documentId/versions', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireMember(String(req.params.documentId), personId);
  const result = await pool.query(
    `SELECT id, revision, title, created_by, created_at FROM document_versions
      WHERE document_id = $1 ORDER BY revision DESC`,
    [String(req.params.documentId)],
  );
  res.json({ versions: result.rows });
}));

app.post('/api/documents/:documentId/versions/:versionId/restore', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  await requireMember(String(req.params.documentId), user.id, 'OWNER');
  await requireNotBlocked(user.id);
  const restored = await inTransaction(async (client) => {
    const lockedDocument = await client.query('SELECT id, content FROM documents WHERE id = $1 FOR UPDATE', [String(req.params.documentId)]);
    if (!lockedDocument.rowCount) throw new HttpError(404, 'Document introuvable.', 'NOT_FOUND');
    const version = await client.query(
      'SELECT title, content, state_update FROM document_versions WHERE id = $1 AND document_id = $2',
      [String(req.params.versionId), String(req.params.documentId)],
    );
    if (!version.rowCount) throw new HttpError(404, 'Version introuvable.', 'VERSION_NOT_FOUND');
    const document = await client.query(
      `UPDATE documents SET title = $2, content = $3, revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING id, title, content, revision::int AS revision, updated_at`,
      [String(req.params.documentId), version.rows[0].title, version.rows[0].content],
    );
    const row = document.rows[0];
    await client.query(
      `INSERT INTO document_versions (document_id, revision, title, content, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.revision, row.title, row.content, user.id],
    );
    const collaborativeUpdate = await restoreCollaborativeText(
      client, row.id, lockedDocument.rows[0].content as string, row.content as string,
      version.rows[0].state_update as Buffer | null,
    );
    await client.query('UPDATE document_versions SET state_update = $3 WHERE document_id = $1 AND revision = $2', [row.id, row.revision, Buffer.from(collaborativeUpdate)]);
    return { ...row, collaborativeUpdate };
  });
  const { collaborativeUpdate, ...response } = restored;
  await broadcastDocumentUpdate(String(req.params.documentId), collaborativeUpdate, response.revision);
  res.json(response);
}));

app.get('/api/admin/overview', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  requireAdmin(user);
  const [counts, people, reservations] = await Promise.all([
    pool.query(`SELECT (SELECT count(*) FROM people)::int AS accounts,
                       (SELECT count(*) FROM documents)::int AS documents,
                       (SELECT count(*) FROM download_links)::int AS links,
                       (SELECT count(*) FROM reservations)::int AS reservations,
                       (SELECT count(*) FROM reservations WHERE state IN ('QUEUED','PROCESSING'))::int AS pending_pdfs,
                       (SELECT count(*) FROM last_copy_notifications WHERE state <> 'SENT')::int AS pending_notifications`),
    pool.query(`SELECT p.id, p.name, p.email, p.account_role AS role, p.created_at,
                       EXISTS (SELECT 1 FROM temporary_blocks b WHERE b.person_id = p.id AND b.starts_at <= now() AND b.ends_at > now()) AS blocked
                  FROM people p ORDER BY p.created_at DESC LIMIT 100`),
    pool.query(`SELECT r.id, r.state, r.document_revision::int AS revision, r.created_at, d.title
                  FROM reservations r JOIN download_links l ON l.id = r.link_id
                  JOIN documents d ON d.id = l.document_id ORDER BY r.created_at DESC LIMIT 20`),
  ]);
  res.json({ metrics: counts.rows[0], people: people.rows, recentReservations: reservations.rows });
}));

app.post('/api/admin/people/:personId/blocks', asyncRoute(async (req, res) => {
  const admin = await signedIn(req);
  requireAdmin(admin);
  const input = blockSchema.parse(req.body);
  const target = await pool.query('SELECT id FROM people WHERE id = $1', [String(req.params.personId)]);
  if (!target.rowCount) throw new HttpError(404, 'Compte introuvable.', 'PERSON_NOT_FOUND');
  const result = await pool.query(
    `INSERT INTO temporary_blocks (person_id, reason, starts_at, ends_at)
     VALUES ($1, $2, now(), now() + ($3 * interval '1 hour'))
     RETURNING id, reason, starts_at, ends_at`,
    [String(req.params.personId), input.reason, input.durationHours],
  );
  res.status(201).json(result.rows[0]);
}));

app.delete('/api/admin/people/:personId/blocks', asyncRoute(async (req, res) => {
  const admin = await signedIn(req);
  requireAdmin(admin);
  await pool.query('UPDATE temporary_blocks SET ends_at = now() WHERE person_id = $1 AND ends_at > now()', [String(req.params.personId)]);
  res.status(204).end();
}));

app.post('/api/documents/:documentId/links', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  await requireNotBlocked(personId);
  const input = linkSchema.parse(req.body);
  await requireMember(String(req.params.documentId), personId);
  const result = await pool.query(
    `INSERT INTO download_links (document_id, creator_id, initial_limit, remaining, expires_at)
     VALUES ($1, $2, $3, $3, $4)
     RETURNING id, token, initial_limit, remaining, state, created_at, expires_at`,
    [String(req.params.documentId), personId, input.limit, input.expiresAt ?? null],
  );
  const link = result.rows[0];
  res.status(201).json({ ...link, url: `${process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173'}/share/${link.token}` });
}));

app.get('/api/links', asyncRoute(async (req, res) => {
  const user = await signedIn(req);
  const personId = user.id;
  const result = await pool.query(
    `SELECT l.id, l.token, l.document_id, d.title, l.initial_limit, l.remaining, l.state, l.created_at
       FROM download_links l JOIN documents d ON d.id = l.document_id
      WHERE l.creator_id = $1 ORDER BY l.created_at DESC`,
    [personId],
  );
  res.json({ links: result.rows });
}));

app.get('/api/public/links/:token', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT l.token, l.remaining, l.initial_limit, l.state, l.expires_at, d.title
       FROM download_links l JOIN documents d ON d.id = l.document_id WHERE l.token = $1`,
    [String(req.params.token)],
  );
  if (!result.rowCount) throw new HttpError(404, 'Lien introuvable.', 'NOT_FOUND');
  const link = result.rows[0];
  res.json({ ...link, state: link.expires_at && new Date(link.expires_at) <= new Date() ? 'EXPIRED' : link.state });
}));

app.post('/api/public/links/:token/reservations', asyncRoute(async (req, res) => {
  const requestKey = req.header('idempotency-key')?.trim() || crypto.randomUUID();
  if (requestKey.length > 200) throw new HttpError(400, 'Clé de requête trop longue.', 'INVALID_REQUEST_KEY');
  const reservation = await inTransaction(async (client) => {
    const existing = await client.query(
      `SELECT r.id, r.state, r.document_revision, r.pdf_key
         FROM reservations r JOIN download_links l ON l.id = r.link_id
        WHERE l.token = $1 AND r.request_key = $2`,
      [String(req.params.token), requestKey],
    );
    if (existing.rowCount) return { ...existing.rows[0], replayed: true };

    const lockedLink = await client.query('SELECT id FROM download_links WHERE token = $1 FOR UPDATE', [String(req.params.token)]);
    if (!lockedLink.rowCount) throw new HttpError(404, 'Lien introuvable.', 'NOT_FOUND');

    const replay = await client.query(
      `SELECT r.id, r.state, r.document_revision, r.pdf_key
         FROM reservations r WHERE r.link_id = $1 AND r.request_key = $2`,
      [lockedLink.rows[0].id, requestKey],
    );
    if (replay.rowCount) return { ...replay.rows[0], replayed: true };

    const link = await client.query(
      `UPDATE download_links
          SET remaining = remaining - 1,
              state = CASE WHEN remaining = 1 THEN 'EXHAUSTED' ELSE 'ACTIVE' END
        WHERE token = $1 AND state = 'ACTIVE' AND remaining > 0
          AND (expires_at IS NULL OR expires_at > now())
        RETURNING id, document_id, creator_id, remaining`,
      [String(req.params.token)],
    );
    if (!link.rowCount) {
      const found = await client.query('SELECT state, remaining FROM download_links WHERE token = $1', [String(req.params.token)]);
      if (!found.rowCount) throw new HttpError(404, 'Lien introuvable.', 'NOT_FOUND');
      throw new HttpError(410, 'Ce lien est épuisé ou expiré.', 'LINK_EXHAUSTED');
    }
    const current = await client.query(
      'SELECT title, content, revision FROM documents WHERE id = $1',
      [link.rows[0].document_id],
    );
    if (!current.rowCount) throw new HttpError(404, 'Document introuvable.', 'NOT_FOUND');
    const inserted = await client.query(
      `INSERT INTO reservations (link_id, request_key, document_revision, captured_title, captured_content)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, state, document_revision, pdf_key`,
      [link.rows[0].id, requestKey, current.rows[0].revision, current.rows[0].title, current.rows[0].content],
    );
    if (Number(link.rows[0].remaining) === 0) {
      await client.query(
        `INSERT INTO last_copy_notifications (link_id, recipient_email)
         SELECT $1, email FROM people WHERE id = $2 ON CONFLICT (link_id) DO NOTHING`,
        [link.rows[0].id, link.rows[0].creator_id],
      );
    }
    return { ...inserted.rows[0], remaining: link.rows[0].remaining, replayed: false };
  });
  if (!reservation.replayed && process.env.SQS_PDF_QUEUE_URL) {
    try {
      await sqs.send(new SendMessageCommand({
        QueueUrl: process.env.SQS_PDF_QUEUE_URL,
        MessageBody: JSON.stringify({ reservationId: reservation.id }),
      }));
    } catch (error) {
      // The PostgreSQL queue remains the durable fallback; the worker polls it as well.
      console.error('Envoi SQS échoué; le worker utilisera la file PostgreSQL.', error);
    }
  }
  res.status(reservation.replayed ? 200 : 202).json(reservation);
}));

app.get('/api/public/reservations/:reservationId', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, state, document_revision, pdf_key, error_message, created_at
       FROM reservations WHERE id = $1`,
    [String(req.params.reservationId)],
  );
  if (!result.rowCount) throw new HttpError(404, 'Demande introuvable.', 'NOT_FOUND');
  const reservation = result.rows[0];
  res.json({
    id: reservation.id,
    state: reservation.state,
    revision: reservation.document_revision,
    error: reservation.error_message,
    downloadUrl: reservation.state === 'READY' ? `${process.env.API_BASE_URL ?? `http://localhost:${process.env.PORT ?? '3000'}`}/api/public/reservations/${reservation.id}/file` : null,
  });
}));

app.get('/api/public/reservations/:reservationId/file', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT state, pdf_key, captured_title FROM reservations WHERE id = $1`,
    [String(req.params.reservationId)],
  );
  if (!result.rowCount) throw new HttpError(404, 'Fichier introuvable.', 'NOT_FOUND');
  const reservation = result.rows[0];
  if (reservation.state !== 'READY' || !reservation.pdf_key) {
    throw new HttpError(409, 'Le PDF n’est pas encore prêt.', 'PDF_NOT_READY');
  }
  if (process.env.S3_BUCKET) {
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: reservation.pdf_key,
      ResponseContentDisposition: 'attachment; filename="document.pdf"',
    }), { expiresIn: 120 });
    res.redirect(302, url);
    return;
  }
  const filePath = path.resolve(process.env.PDF_STORAGE_DIR ?? './data/pdfs', reservation.pdf_key);
  res.type('application/pdf').download(filePath, 'document.pdf');
}));

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Données invalides.', code: 'VALIDATION_ERROR', details: error.issues });
  } else if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, code: error.code });
  } else if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    res.status(409).json({ error: 'Un compte existe déjà avec cette adresse e-mail.', code: 'EMAIL_ALREADY_REGISTERED' });
  } else {
    console.error(error);
    res.status(500).json({ error: 'Une erreur interne est survenue.', code: 'INTERNAL_ERROR' });
  }
});

export default app;
