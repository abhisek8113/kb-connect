// Small helpers to keep routes clean and errors consistent.
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function parse(schema, data, res) {
  const r = schema.safeParse(data);
  if (!r.success) {
    res.status(400).json({ error: 'validation', details: r.error.flatten() });
    return null;
  }
  return r.data;
}

// Public projection of a user — NEVER includes phone or password_hash.
export const publicUser = (u) => ({
  id: u.id, role: u.role, name: u.full_name,
  subject: u.subject || null, std: u.std || null, batch: u.batch || null,
});
