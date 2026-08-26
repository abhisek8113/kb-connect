import http from 'node:http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as IOServer } from 'socket.io';

import { config } from './config.js';
import { authRouter } from './routes/auth.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { messagesRouter } from './routes/messages.routes.js';
import { meetingsRouter } from './routes/meetings.routes.js';
import { notificationsRouter } from './routes/notifications.routes.js';
import { aiRouter } from './routes/ai.routes.js';
import { attachSockets } from './sockets/index.js';
import { makeNotifier } from './services/notify.js';
import { runForAll } from './ai/engine.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Auth endpoints are the most abused surface -- rate-limit them hard.
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300 }));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/meetings', meetingsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/ai', aiRouter);

// Serve the front-end portals (static) from ../../web
app.use(express.static(new URL('../../web', import.meta.url).pathname));

// Central error handler -- never leak stack traces to clients in production.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: config.env === 'production' ? 'server error' : String(err.message) });
});

const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: config.corsOrigins, credentials: true } });

// Shared presence map + notifier, then attach socket handlers.
const online = new Map();
const notify = makeNotifier(io, online);
attachSockets(io, notify, online);

// Make io + notify reachable from REST routes (e.g. admin announce, REST send).
app.set('io', io);
app.set('notify', notify);

server.listen(config.port, () => {
  console.log(`KB Connect server on :${config.port} (${config.env})`);
});

// Background AI runner: recompute all student insights every 30 min.
// (For production, move to a cron/worker; kept in-process here for simplicity.)
const AI_INTERVAL_MS = Number(process.env.AI_INTERVAL_MS || 30 * 60 * 1000);
if (AI_INTERVAL_MS > 0) {
  setTimeout(() => runForAll().then(n => console.log(`AI: initial run over ${n} students`)).catch(() => {}), 4000);
  setInterval(() => runForAll().catch(e => console.error('AI run error', e.message)), AI_INTERVAL_MS);
}

export { app, server, io };
