import { randomUUID } from 'node:crypto';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
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

const account = await post('/api/auth/register', {
  name: 'Preuve PDF de bout en bout',
  email: `${tag}@example.test`,
  password: 'Load-test-password-123',
});
const cookie = account.response.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error('Cookie de session absent.');
const document = await post('/api/documents', { title: 'Preuve de génération PDF' }, cookie);
const save = await fetch(`${base}/api/documents/${document.data.id}/content`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ content: 'Texte réservé au test de génération PDF.', baseRevision: 0 }),
});
if (!save.ok) throw new Error(`Sauvegarde impossible : HTTP ${save.status} ${await save.text()}`);
const link = await post(`/api/documents/${document.data.id}/links`, { limit: 2 }, cookie);
const reservation = await fetch(`${base}/api/public/links/${link.data.token}/reservations`, {
  method: 'POST',
  headers: { 'idempotency-key': `e2e-${tag}` },
});
if (reservation.status !== 202) throw new Error(`Réservation : HTTP ${reservation.status} ${await reservation.text()}`);
const accepted = await reservation.json();
const started = performance.now();
let status;
let state;
for (let attempt = 0; attempt < 60; attempt++) {
  const response = await fetch(`${base}/api/public/reservations/${accepted.id}`);
  status = response.status;
  state = await response.json();
  if (state.state === 'READY') break;
  if (state.state === 'FAILED' || status >= 500) throw new Error(`Génération PDF échouée : ${JSON.stringify(state)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (state?.state !== 'READY') throw new Error(`PDF non prêt dans le délai prévu : ${JSON.stringify(state)}`);
const file = await fetch(`${base}/api/public/reservations/${accepted.id}/file`);
const bytes = new Uint8Array(await file.arrayBuffer());
const signature = Buffer.from(bytes.slice(0, 5)).toString('ascii');
if (!file.ok || signature !== '%PDF-') throw new Error(`Fichier invalide : HTTP ${file.status}, signature ${signature}`);
console.log(JSON.stringify({
  date: new Date().toISOString(),
  target: base,
  reservation_status: reservation.status,
  status_poll_http: status,
  final_state: state.state,
  revision: state.revision,
  download_status: file.status,
  pdf_signature: signature,
  file_bytes: bytes.length,
  processing_and_polling_ms: Number((performance.now() - started).toFixed(1)),
  quota_uses_consumed: 1,
}, null, 2));
