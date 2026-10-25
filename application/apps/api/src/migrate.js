import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const schemaPath = process.env.SCHEMA_FILE ?? new URL('../../../db/init/001_schema.sql', import.meta.url);
  const sql = await readFile(schemaPath, 'utf8');
  await pool.query(sql);
  console.log('Schéma PostgreSQL à jour.');
} finally {
  await pool.end();
}
