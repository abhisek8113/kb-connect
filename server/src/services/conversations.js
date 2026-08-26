import { query } from '../db.js';

// Get or create the single DM conversation row for a user pair (sorted).
export async function getOrCreateDm(aId, bId) {
  const [member_a, member_b] = [aId, bId].sort();
  const found = await query(
    'select * from conversations where kind=$1 and member_a=$2 and member_b=$3',
    ['dm', member_a, member_b]);
  if (found.rows[0]) return found.rows[0];
  const ins = await query(
    `insert into conversations (kind, member_a, member_b) values ('dm',$1,$2)
     on conflict (member_a, member_b) do update set kind='dm' returning *`,
    [member_a, member_b]);
  return ins.rows[0];
}

export async function getOrCreateBatch(batch) {
  const found = await query('select * from conversations where kind=$1 and batch=$2', ['batch', batch]);
  if (found.rows[0]) return found.rows[0];
  const ins = await query(
    `insert into conversations (kind, batch) values ('batch',$1)
     on conflict (batch) do update set kind='batch' returning *`, [batch]);
  return ins.rows[0];
}
