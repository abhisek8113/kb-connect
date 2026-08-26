import { readFileSync } from 'node:fs';
import { pool } from './db.js';

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const aiSql = readFileSync(new URL('./schema_ai.sql', import.meta.url), 'utf8');
try {
  await pool.query(sql);
  await pool.query(aiSql);
  console.log('✅ schema applied (core + AI)');
} catch (e) {
  console.error('migration failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
