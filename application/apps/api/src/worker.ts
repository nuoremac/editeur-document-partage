import 'dotenv/config';
import { createWriteStream } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import PDFDocument from 'pdfkit';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { pool, inTransaction } from './db.js';

const storageDir = path.resolve(process.env.PDF_STORAGE_DIR ?? './data/pdfs');
const s3 = new S3Client({ region: process.env.AWS_REGION });
const sqs = new SQSClient({ region: process.env.AWS_REGION });
const ses = new SESv2Client({ region: process.env.AWS_REGION });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildPdf(title: string, revision: string, content: string, outputPath: string) {
  const temporaryPath = `${outputPath}.tmp`;
  const populated = new PDFDocument({ size: 'A4', margin: 50, info: { Title: title, Author: 'Journal collaboratif' } });
  const write = pipeline(populated, createWriteStream(temporaryPath));
  populated.fontSize(20).text(title, { align: 'center' });
  populated.moveDown(0.5).fontSize(9).fillColor('#666666').text(`Version ${revision}`, { align: 'center' });
  populated.moveDown(2).fillColor('#111111').fontSize(11).text(content || 'Document vide.', { align: 'left', lineGap: 4 });
  populated.end();
  await write;
  await rename(temporaryPath, outputPath);
}

async function processOne(reservationId?: string): Promise<boolean> {
  const job = await inTransaction(async (client) => {
    const selected = await client.query(
      `SELECT id, captured_title, captured_content, document_revision
         FROM reservations
        WHERE (state = 'QUEUED' OR (state = 'PROCESSING' AND lease_until < now()))
          AND ($1::uuid IS NULL OR id = $1::uuid)
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [reservationId ?? null],
    );
    if (!selected.rowCount) return null;
    const row = selected.rows[0];
    await client.query(`UPDATE reservations SET state = 'PROCESSING', lease_until = now() + interval '10 minutes', updated_at = now() WHERE id = $1`, [row.id]);
    return row;
  });
  if (!job) return false;

  const key = `${job.id}.pdf`;
  const filePath = path.join(storageDir, key);
  try {
    await mkdir(storageDir, { recursive: true });
    await buildPdf(job.captured_title, String(job.document_revision), job.captured_content, filePath);
    if (process.env.S3_BUCKET) {
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: `pdf/${key}`,
        Body: await readFile(filePath),
        ContentType: 'application/pdf',
        ContentDisposition: 'attachment; filename="document.pdf"',
      }));
      await unlink(filePath);
      await pool.query(`UPDATE reservations SET state = 'READY', pdf_key = $2, lease_until = NULL, updated_at = now() WHERE id = $1`, [job.id, `pdf/${key}`]);
    } else {
      await pool.query(`UPDATE reservations SET state = 'READY', pdf_key = $2, lease_until = NULL, updated_at = now() WHERE id = $1`, [job.id, key]);
    }
    console.log(`PDF prêt pour la réservation ${job.id}`);
  } catch (error) {
    console.error(`Échec de génération PDF ${job.id}`, error);
    await pool.query(
      `UPDATE reservations SET state = 'FAILED', lease_until = NULL, error_message = 'La génération du PDF a échoué.', updated_at = now() WHERE id = $1`,
      [job.id],
    );
  }
  return true;
}

async function processOneNotification(): Promise<boolean> {
  if (!process.env.SES_FROM_EMAIL) return false;
  const notification = await inTransaction(async (client) => {
    const selected = await client.query(
      `SELECT n.id, n.recipient_email, d.title, n.attempts
         FROM last_copy_notifications n
         JOIN download_links l ON l.id = n.link_id
         JOIN documents d ON d.id = l.document_id
        WHERE (n.state = 'PENDING' AND n.next_attempt_at <= now())
           OR (n.state = 'SENDING' AND n.lease_until < now())
        ORDER BY n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
    );
    if (!selected.rowCount) return null;
    const row = selected.rows[0];
    await client.query(
      `UPDATE last_copy_notifications SET state = 'SENDING', attempts = attempts + 1,
              lease_until = now() + interval '10 minutes' WHERE id = $1`, [row.id],
    );
    return row;
  });
  if (!notification) return false;
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: process.env.SES_FROM_EMAIL,
      Destination: { ToAddresses: [notification.recipient_email] },
      Content: { Simple: {
        Subject: { Data: 'Lien de téléchargement épuisé' },
        Body: { Text: { Data: `Le quota de téléchargement du lien associé à « ${notification.title} » vient d’atteindre zéro.` } },
      } },
    }));
    await pool.query(`UPDATE last_copy_notifications SET state = 'SENT', sent_at = now(), lease_until = NULL, last_error = NULL WHERE id = $1`, [notification.id]);
  } catch (error) {
    const attempts = Number(notification.attempts) + 1;
    await pool.query(
      `UPDATE last_copy_notifications SET state = 'PENDING', lease_until = NULL,
              next_attempt_at = now() + interval '1 minute' * LEAST(60, power(2, $2)::int),
              last_error = $3 WHERE id = $1`,
      [notification.id, attempts, String(error).slice(0, 1000)],
    );
    console.error(`Échec d’envoi de la notification ${notification.id}`, error);
  }
  return true;
}

console.log('Worker PDF démarré.');
try {
  while (true) {
    await processOneNotification();
    let message: { MessageId?: string; ReceiptHandle?: string; Body?: string } | undefined;
    const queueUrl = process.env.SQS_PDF_QUEUE_URL;
    if (queueUrl) {
      const received = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5, VisibilityTimeout: 600,
      }));
      message = received.Messages?.[0];
    }
    let reservationId: string | undefined;
    if (message?.Body) {
      try {
        const candidate = JSON.parse(message.Body).reservationId;
        if (typeof candidate === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) reservationId = candidate;
      }
      catch { reservationId = undefined; }
    }
    const processed = message && !reservationId ? false : await processOne(reservationId);
    if (message?.ReceiptHandle && queueUrl) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    if (!processed) await wait(queueUrl ? 100 : 800);
  }
} finally {
  await pool.end();
}
