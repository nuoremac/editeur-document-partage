import { inTransaction } from './db.js';

const STRIKE_LIMIT = 5;

export async function recordCreditAbuse(personId: string, reason: string) {
  return inTransaction(async (client) => {
    await client.query('SELECT id FROM people WHERE id = $1 FOR UPDATE', [personId]);
    await client.query(
      'INSERT INTO abuse_attempts (person_id, reason) VALUES ($1, $2)',
      [personId, reason.slice(0, 200)],
    );
    const result = await client.query(
      `SELECT count(*)::int AS strikes FROM abuse_attempts
        WHERE person_id = $1 AND created_at > now() - interval '5 minutes'`,
      [personId],
    );
    const strikes = Number(result.rows[0]?.strikes ?? 0);
    if (strikes >= STRIKE_LIMIT) {
      const block = await client.query(
        `INSERT INTO temporary_blocks (person_id, reason, starts_at, ends_at)
         SELECT $1, 'Blocage automatique : tentatives répétées de dépassement du crédit', now(), now() + interval '1 hour'
          WHERE NOT EXISTS (
            SELECT 1 FROM temporary_blocks WHERE person_id = $1 AND starts_at <= now() AND ends_at > now()
          ) RETURNING id`,
        [personId],
      );
      return { strikes, blocked: Boolean(block.rowCount) || strikes >= STRIKE_LIMIT };
    }
    return { strikes, blocked: false };
  });
}
