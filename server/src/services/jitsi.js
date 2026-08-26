import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Deterministic, opaque room name for a DM (no names, no phone numbers).
export function roomForPair(aId, bId) {
  const key = [aId, bId].sort().join('|');
  return 'kb-' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 24);
}
export function roomForBatch(batch) {
  return 'kbb-' + crypto.createHash('sha256').update('batch:' + batch).digest('hex').slice(0, 20);
}

// Short-lived Jitsi JWT granting a specific user access to one room only.
// `moderator` is true for the tutor/admin who starts the meeting.
export function jitsiToken({ user, room, moderator }) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      aud: config.jitsi.appId,
      iss: config.jitsi.appId,
      sub: config.jitsi.domain,
      room,                                   // scoped to a single room
      exp: now + config.jitsi.tokenTtl,
      nbf: now - 5,
      moderator: !!moderator,
      context: {
        user: {
          id: user.id,
          name: user.full_name,               // display name only, never phone
          moderator: !!moderator,
        },
      },
    },
    config.jitsi.appSecret
  );
}
