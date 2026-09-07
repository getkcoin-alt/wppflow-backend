import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import wppconnect from '@wppconnect-team/wppconnect';
import {
  initDatabase,
  getDatabaseStatus,
  getContacts,
  getChats,
  createChat,
  createMessage,
  updateChat,
  getAutomations,
  getCampaigns,
  getPool,
  getWorkspaceUserIds
} from './db.js';
import authRoutes from './routes/authRoutes.js';
import { authenticateToken, JWT_SECRET } from './routes/authRoutes.js';
import jwt from 'jsonwebtoken';
import dataRoutes from './routes/dataRoutes.js';

dotenv.config();

initDatabase().catch(err => console.error('Database init error:', err));

const PORT = process.env.PORT || 8080;
const TOKEN_DIR = process.env.TOKEN_DIR || './tokens';
const SESSION_REGISTRY = path.join(TOKEN_DIR, '.connected-sessions.json');

if (!fs.existsSync(TOKEN_DIR)) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
}

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  else res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(cors({ origin: true, credentials: true }));
app.options('*', (req, res) => res.status(204).end());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

const sessions = new Map();

async function canAccessSession(userId, sessionName, session) {
  if (!session) return false;
  const ownerId = session.ownerId || await resolveSessionOwner(sessionName);
  if (!ownerId) return true;
  const workspaceIds = await getWorkspaceUserIds(userId);
  return workspaceIds.includes(Number(ownerId));
}

console.log('🚀 WppFlow Core Backend Engine starting...');
console.log(`📁 Token dir: ${path.resolve(TOKEN_DIR)}`);
console.log(`📋 Node: ${process.version}`);

// ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readConnectedSessionNames() {
  try {
    const value = JSON.parse(fs.readFileSync(SESSION_REGISTRY, 'utf8'));
    return Array.isArray(value) ? value.filter(name => typeof name === 'string') : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`⚠️  Could not read session registry: ${e.message}`);
    return [];
  }
}

function setSessionRegistered(sessionName, registered) {
  const names = new Set(readConnectedSessionNames());
  if (registered) names.add(sessionName);
  else names.delete(sessionName);
  const temporaryFile = `${SESSION_REGISTRY}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify([...names].sort()));
    fs.renameSync(temporaryFile, SESSION_REGISTRY);
  } catch (e) {
    console.warn(`⚠️  Could not update session registry: ${e.message}`);
    try { fs.unlinkSync(temporaryFile); } catch {}
  }
}

function clearChromiumLocks(sessionName) {
  const sessionDir = path.join(TOKEN_DIR, sessionName);
  if (!fs.existsSync(sessionDir)) return;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(sessionDir, f);
    // Chromium creates these entries as symlinks. existsSync() follows a
    // symlink and returns false when its target belonged to an old container,
    // which is exactly the stale-lock case after a Railway redeploy.
    try {
      fs.lstatSync(p);
      fs.unlinkSync(p);
      console.log(`🔓 [${sessionName}] Removed stale lock: ${f}`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`⚠️  Could not remove ${f}: ${e.message}`);
    }
  }
  try {
    for (const entry of fs.readdirSync(sessionDir)) {
      if (entry.startsWith('.com.google.Chrome') || entry.startsWith('.org.chromium')) {
        try { fs.unlinkSync(path.join(sessionDir, entry)); } catch {}
      }
    }
  } catch {}
}

async function resolveSessionOwner(sessionName) {
  const activeSession = sessions.get(sessionName);
  if (activeSession?.ownerId) return activeSession.ownerId;
  try {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(`SELECT DISTINCT user_id FROM chats WHERE channel = $1 LIMIT 1`, [sessionName]);
      if (rows.length) return rows[0].user_id;
      const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`);
      if (adminRows.length) return adminRows[0].id;
      const { rows: anyRows } = await pool.query(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
      if (anyRows.length) return anyRows[0].id;
    }
  } catch (e) { console.warn('resolveSessionOwner:', e.message); }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
async function runAutomationEngine(sessionName, userId, message, client) {
  try {
    const rules = (await getAutomations(userId)).filter(a => a.isEnabled);
    for (const rule of rules) {
      const body = (message.body || '').trim();
      let matched = false;
      switch (rule.triggerType) {
        case 'keyword':
        case 'contains':  matched = body.toLowerCase().includes((rule.triggerCondition || '').toLowerCase()); break;
        case 'exact':     matched = body.toLowerCase() === (rule.triggerCondition || '').toLowerCase(); break;
        case 'regex':     try { matched = new RegExp(rule.triggerCondition, 'i').test(body); } catch { matched = false; } break;
        case 'any_message': matched = body.length > 0; break;
      }
      if (!matched) continue;
      console.log(`⚡ [${sessionName}] Automation '${rule.name}' triggered`);
      try {
        if (rule.actionType === 'reply_text' && rule.actionSummary)
          await client.sendText(message.from, rule.actionSummary);
        else if (rule.actionType === 'reply_buttons' && rule.actionSummary) {
          const parts = rule.actionSummary.split('|||');
          const btns = parts.slice(1).map((t, i) => ({ id: `btn_${i}`, text: t }));
          if (btns.length) await client.sendButtonList(message.from, parts[0], btns);
        }
        const pool = getPool();
        if (pool) await pool.query(`UPDATE automations SET executions_count = executions_count + 1 WHERE id = $1`, [rule.id]);
        io.emit('automation:fired', { session: sessionName, ruleId: rule.id, ruleName: rule.name, from: message.from });
      } catch (e) { console.error(`❌ Automation '${rule.name}' failed:`, e.message); }
    }
  } catch (e) { console.error(`Automation engine error [${sessionName}]:`, e.message); }
}

async function handleInboundMessage(sessionName, message) {
  if (message.fromMe || message.isGroupMsg) return;
  const userId = await resolveSessionOwner(sessionName);
  if (!userId) { console.warn(`⚠️  [${sessionName}] No owner — message not persisted.`); return; }
  try {
    const senderPhone = message.from.replace('@c.us', '');
    const senderName = message.sender?.name || message.notifyName || senderPhone;
    const existing = await getChats(userId);
    let chat = existing.find(c => c.phone === senderPhone || c.phone === message.from);
    if (!chat) {
      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      chat = await createChat(userId, { contactName: senderName, phone: senderPhone, avatar: '', channel: sessionName, assignedTo: '', isGroup: false, lastMessage: { text: message.body || '', timestamp: ts, status: 'delivered', fromMe: false }, tags: [] });
      console.log(`💬 [${sessionName}] New chat: ${chat.id}`);
      io.to(`workspace:${userId}`).emit('chat:created', { session: sessionName, chat });
    }
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const saved = await createMessage(chat.id, { sender: 'customer', agentName: senderName, text: message.body || '', type: message.type || 'text', status: 'delivered', timestamp: ts });
    await updateChat(userId, chat.id, { unreadCount: (chat.unreadCount || 0) + 1, lastMessage: { text: message.body || '', timestamp: ts, status: 'delivered', fromMe: false } });
    io.to(`workspace:${userId}`).emit('session:message', { session: sessionName, chatId: chat.id, message: { id: message.id, from: message.from, senderName, body: message.body, type: message.type, timestamp: ts, savedMessageId: saved.id } });
    return { userId, chat };
  } catch (e) { console.error(`Inbound error [${sessionName}]:`, e.message); return null; }
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    socket.user = jwt.verify(token, JWT_SECRET);
    const workspaceIds = await getWorkspaceUserIds(socket.user.id);
    workspaceIds.forEach((id) => socket.join(`workspace:${id}`));
    next();
  } catch (error) { next(new Error('Invalid socket credentials')); }
});

io.on('connection', (socket) => {
  console.log(`⚡ Socket: ${socket.id}`);
  socket.emit('sessions:init', Array.from(sessions.entries()).map(([name, d]) => ({ name, status: d.status, phone: d.phone, hasQr: !!d.qrcode })));
  socket.on('disconnect', () => console.log(`🔌 Socket: ${socket.id}`));
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function startSession(sessionName, ownerId = null) {
  if (sessions.has(sessionName)) {
    const ex = sessions.get(sessionName);
    if (!ex.ownerId && ownerId) ex.ownerId = ownerId;
    if (['CONNECTED', 'STARTING', 'QRCODE'].includes(ex.status)) return ex;
  }

  clearChromiumLocks(sessionName);

  const sd = {
    client: null, status: 'STARTING', qrcode: null,
    error: null, qrScanned: false,
    ownerId,
    phone: null, battery: 100, antiBanHealth: 98,
    warmupDay: 14, lastActive: new Date().toISOString()
  };
  sessions.set(sessionName, sd);
  io.emit('session:status', { session: sessionName, status: 'STARTING' });

  try {
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`📸 [${sessionName}] QR attempt ${attempts}`);
        const qr = base64Qr?.startsWith('data:image') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        sd.qrcode = qr;
        sd.qrScanned = false;
        sd.status = 'QRCODE';
        io.emit('session:qr', { session: sessionName, qrcode: qr, attempts });
        io.emit('session:status', { session: sessionName, status: 'QRCODE' });
      },
      statusFind: (statusSession, session) => {
        console.log(`🔄 [${session}] ${statusSession}`);

        if (statusSession === 'qrReadSuccess') {
          // The code was accepted, but WhatsApp is still synchronizing.
          sd.qrScanned = true;
          sd.status = 'AUTHENTICATING';
          sd.qrcode = null;
          io.emit('session:status', { session, status: 'AUTHENTICATING' });

        } else if (['isLogged', 'inChat'].includes(statusSession) && sd.qrScanned) {
          // A QR was accepted and the client is now ready.
          sd.status = 'CONNECTED';
          sd.qrcode = null;
          sd.error = null;
          setSessionRegistered(sessionName, true);
          io.emit('session:status', { session, status: 'CONNECTED' });

        } else if (['isLogged', 'inChat'].includes(statusSession)) {
          // Existing profiles can briefly report logged-in while WhatsApp Web is
          // still deciding that they are unpaired. Do not complete the UI yet.
          io.emit('session:status', { session, status: 'AUTHENTICATING' });

        } else if (statusSession === 'notLogged' || statusSession === 'disconnectedMobile') {
          // Normal intermediate states — WhatsApp Web loaded, QR incoming
          // Do NOT change sd.status here; catchQR will set it to QRCODE
          // Just forward the raw status for debugging
          io.emit('session:status', { session, status: statusSession });

        } else if (statusSession === 'autocloseCalled') {
          // QR wasn't scanned in time — NOT a crash, just expired
          // Emit a specific 'EXPIRED' status so frontend can show "try again"
          console.log(`⏰ [${session}] QR expired (autocloseCalled)`);
          sd.status = 'EXPIRED';
          sd.qrcode = null;
          io.emit('session:status', { session, status: 'EXPIRED' });

        } else if (statusSession === 'browserClose') {
          // Chromium actually closed — real failure
          sd.status = 'FAILED';
          io.emit('session:status', { session, status: 'FAILED' });

        } else {
          // All other statuses: just forward, don't overwrite sd.status
          io.emit('session:status', { session, status: statusSession });
        }
      },
      headless: true,
      useChrome: true,
      devtools: false,
      logQR: true,
      autoClose: 120000,  // 2 min to scan
      folderNameToken: TOKEN_DIR,
      browserArgs: ['--no-sandbox'],
      puppeteerOptions: {},
    });

    sd.client = client;

    // For a restored, genuinely connected profile there is no QR scan event.
    // Give WhatsApp Web time to invalidate stale registration before accepting
    // it as connected, then verify both registered and main-ready state.
    await sleep(10000);
    if (sd.status !== 'QRCODE' && sd.status !== 'EXPIRED' && sd.status !== 'FAILED') {
      const ready = await client.page.evaluate(() =>
        Boolean(WPP?.conn?.isRegistered?.() && WPP?.conn?.isMainReady?.())
      ).catch(() => false);
      if (ready) {
        sd.status = 'CONNECTED';
        sd.qrcode = null;
        sd.error = null;
        setSessionRegistered(sessionName, true);
        io.emit('session:status', { session: sessionName, status: 'CONNECTED' });
      }
    }

    try {
      const host = await client.getHostDevice();
      if (host?.id) sd.phone = host.id.user || host.id._serialized;
      const bat = await client.getBatteryLevel();
      if (typeof bat === 'number') sd.battery = bat;
    } catch (e) { console.warn(`⚠️  Telemetry [${sessionName}]:`, e.message); }

    if (sd.status === 'CONNECTED') {
      console.log(`✅ [${sessionName}] Connected! Phone: ${sd.phone}`);
      io.emit('session:status', { session: sessionName, status: 'CONNECTED', phone: sd.phone, battery: sd.battery });
    }

    client.onMessage(async (msg) => {
      const result = await handleInboundMessage(sessionName, msg);
      if (result?.userId) await runAutomationEngine(sessionName, result.userId, msg, client);
    });

    client.onAck((ack) => {
      io.emit('session:ack', { session: sessionName, id: ack.id._serialized || ack.id, ack: ack.ack });
    });

    return sd;

  } catch (err) {
    // autocloseCalled throws an error — handle it gracefully, NOT as FAILED
    if (err.message && (err.message.includes('Auto Close') || err.message.includes('autocloseCalled'))) {
      console.log(`⏰ [${sessionName}] Session closed: QR not scanned in time.`);
      sd.status = 'EXPIRED';
      io.emit('session:status', { session: sessionName, status: 'EXPIRED' });
    } else {
      console.error(`❌ [${sessionName}] Session failed: ${err.message}`);
      sd.status = 'FAILED';
      sd.error = err.message;
      io.emit('session:status', { session: sessionName, status: 'FAILED', error: err.message });
    }
    throw err;
  }
}

async function recoverPersistedSessions() {
  try {
    // Browser profile directories are created before a QR is scanned. Recovering
    // every directory starts one Chromium process per abandoned QR attempt and
    // can exhaust the container. Only sessions that previously connected are
    // recorded in this registry and eligible for automatic recovery.
    const names = readConnectedSessionNames();
    if (!names.length) { console.log('ℹ️  No connected sessions to recover.'); return; }
    console.log(`🔄 Recovering connected sessions: ${names.join(', ')}`);
    for (const name of names) {
      await sleep(3000);
      startSession(name)
        .then(() => console.log(`♻️  Recovered: ${name}`))
        .catch(e => {
          // Suppress autocloseCalled noise on recovery
          if (!e.message?.includes('Auto Close')) {
            console.warn(`⚠️  Could not recover '${name}': ${e.message}`);
          }
        });
    }
  } catch (e) { console.error('Recovery error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api', dataRoutes);

// Session and QR state changes continuously. Prevent browsers and Vercel's
// proxy from revalidating these polling responses into misleading 304s.
app.use('/api/sessions', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.get('/health', (req, res) => res.json({
  status: 'ok', engine: 'wppflow-omniengine', version: '2.7.0',
  database: getDatabaseStatus(), activeSessions: sessions.size,
  sessions: Array.from(sessions.entries()).map(([n, d]) => ({ name: n, status: d.status })),
  uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString()
}));

app.get('/api/sessions', authenticateToken, async (req, res) => {
  const visible = [];
  for (const [name, d] of sessions.entries()) {
    if (await canAccessSession(req.user.id, name, d)) visible.push({
    sessionKey: name, status: d.status, phone: d.phone,
    battery: d.battery, antiBanHealth: d.antiBanHealth,
    warmupDay: d.warmupDay, hasQr: !!d.qrcode, lastActive: d.lastActive
    });
  }
  res.json({ status: 'success', sessions: visible });
});

app.post('/api/sessions/start', authenticateToken, async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ status: 'error', message: 'sessionName is required' });
  startSession(sessionName, req.user.id).catch(e => {
    if (!e.message?.includes('Auto Close')) {
      console.error(`startSession error [${sessionName}]:`, e.message);
    }
  });
  res.json({ status: 'success', message: `Session '${sessionName}' initialization requested`, session: sessionName });
});

app.delete('/api/sessions/:session', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (s && !await canAccessSession(req.user.id, req.params.session, s)) {
    return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  }
  if (s && !s.client && ['STARTING', 'QRCODE', 'AUTHENTICATING'].includes(s.status)) {
    return res.status(409).json({
      status: 'error',
      message: `Session '${req.params.session}' is still initializing and cannot be removed yet`
    });
  }
  if (s?.client) { try { await s.client.close(); } catch {} }
  sessions.delete(req.params.session);
  setSessionRegistered(req.params.session, false);
  io.emit('session:status', { session: req.params.session, status: 'DISCONNECTED' });
  res.json({ status: 'success', message: `Session '${req.params.session}' removed` });
});

app.get('/api/sessions/:session/qr', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s) return res.status(404).json({ status: 'error', message: 'Session not found' });
  if (!await canAccessSession(req.user.id, req.params.session, s)) return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  res.json({ status: 'success', session: req.params.session, sessionStatus: s.status, qrcode: s.qrcode, error: s.error });
});

app.get('/api/sessions/:session/status', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s) return res.status(404).json({ status: 'error', message: 'Session not found' });
  if (!await canAccessSession(req.user.id, req.params.session, s)) return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  res.json({ status: 'success', session: req.params.session, sessionStatus: s.status, phone: s.phone, battery: s.battery, antiBanHealth: s.antiBanHealth, error: s.error });
});

app.post('/api/sessions/:session/send-message', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s?.client) return res.status(400).json({ status: 'error', message: `Session '${req.params.session}' not connected` });
  if (!await canAccessSession(req.user.id, req.params.session, s)) return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  try {
    const target = req.body.phone.includes('@') ? req.body.phone : `${req.body.phone.replace(/\D/g, '')}@c.us`;
    const result = await s.client.sendText(target, req.body.message);
    res.json({ status: 'success', response: { id: result.id, to: target, body: req.body.message, timestamp: Math.floor(Date.now() / 1000) } });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

function whatsappTarget(phone) {
  if (typeof phone !== 'string' || !phone.trim()) throw new Error('phone is required');
  return phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
}

async function getAuthorizedClient(req, res) {
  const sessionName = req.params.session;
  const session = sessions.get(sessionName);
  if (!session?.client) {
    res.status(400).json({ status: 'error', message: `Session '${sessionName}' not connected` });
    return null;
  }
  if (!await canAccessSession(req.user.id, sessionName, session)) {
    res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
    return null;
  }
  return session.client;
}

// WPPConnect media, contact, location and forwarding primitives. Payloads use
// data URLs so the Vercel UI can send files without a separate object store.
app.post('/api/sessions/:session/send-media', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthorizedClient(req, res);
    if (!client) return;
    const { phone, data, filename = 'attachment', caption = '', kind = 'file' } = req.body || {};
    if (!data || typeof data !== 'string' || !data.startsWith('data:')) return res.status(400).json({ status: 'error', message: 'data must be a data URL' });
    const target = whatsappTarget(phone);
    let result;
    if (kind === 'sticker') result = await client.sendImageAsSticker(target, data);
    else if (kind === 'sticker-gif') result = await client.sendImageAsStickerGif(target, data);
    else if (kind === 'image') result = await client.sendImageFromBase64(target, data, filename, caption);
    else result = await client.sendFile(target, data, { filename, caption, type: kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'auto-detect' });
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message || 'Media send failed' }); }
});

app.post('/api/sessions/:session/send-contact', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthorizedClient(req, res);
    if (!client) return;
    const target = whatsappTarget(req.body?.phone);
    const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [{ id: whatsappTarget(req.body?.contactPhone), name: req.body?.name || '' }];
    const result = await client.sendContactVcardList(target, contacts.map((entry) => ({ id: whatsappTarget(entry.id || entry.phone), name: entry.name || '' })));
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message || 'Contact send failed' }); }
});

app.post('/api/sessions/:session/send-location', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthorizedClient(req, res);
    if (!client) return;
    const { phone, latitude, longitude, title = '' } = req.body || {};
    const result = await client.sendLocation(whatsappTarget(phone), String(latitude), String(longitude), title);
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message || 'Location send failed' }); }
});

app.post('/api/sessions/:session/forward', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthorizedClient(req, res);
    if (!client) return;
    const target = whatsappTarget(req.body?.phone);
    const messageIds = req.body?.messageIds || req.body?.messageId;
    if (!messageIds) return res.status(400).json({ status: 'error', message: 'messageId or messageIds is required' });
    const result = client.forwardMessagesV2
      ? await client.forwardMessagesV2(target, messageIds)
      : await client.forwardMessage(target, messageIds);
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message || 'Forward failed' }); }
});

app.post('/api/sessions/:session/send-buttons', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s?.client) return res.status(400).json({ status: 'error', message: `Session '${req.params.session}' not connected` });
  if (!await canAccessSession(req.user.id, req.params.session, s)) return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  try {
    const target = req.body.phone.includes('@') ? req.body.phone : `${req.body.phone.replace(/\D/g, '')}@c.us`;
    const result = await s.client.sendButtonList(target, req.body.title, req.body.buttons.map((b, i) => ({ id: b.id || `btn_${i}`, text: b.text || b.label })));
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/chats', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try { res.json({ status: 'success', chats: await client.listChats({ count: Number(req.query.count) || 100 }) }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/contacts', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try { res.json({ status: 'success', contacts: await client.getAllContacts() }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/groups', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try { res.json({ status: 'success', groups: await client.getAllGroups() }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/groups/:groupId/members', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try { res.json({ status: 'success', members: await client.getGroupMembers(req.params.groupId) }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/blocklist', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try { res.json({ status: 'success', blocklist: await client.getBlockList() }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.post('/api/sessions/:session/close', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (s && !await canAccessSession(req.user.id, req.params.session, s)) {
    return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  }
  if (s?.client) { try { await s.client.close(); } catch (e) { console.warn('close:', e.message); } }
  sessions.delete(req.params.session);
  setSessionRegistered(req.params.session, false);
  io.emit('session:status', { session: req.params.session, status: 'DISCONNECTED' });
  res.json({ status: 'success', message: `Session '${req.params.session}' closed` });
});

// Campaign broadcast
app.post('/api/campaigns/:id/send', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const campaigns = await getCampaigns(userId);
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ status: 'error', message: 'Campaign not found' });
  const connected = Array.from(sessions.entries()).find(([, d]) => d.status === 'CONNECTED' && d.client);
  if (!connected) return res.status(400).json({ status: 'error', message: 'No connected WhatsApp session.' });
  const [sessionName, sd] = connected;
  const delayMs = (campaign.antiBanDelaySeconds || 4) * 1000;
  res.json({ status: 'success', message: `Broadcast started via '${sessionName}'`, campaignId: req.params.id });
  ;(async () => {
    const pool = getPool(); let sent = 0, failed = 0;
    try {
      const contacts = (await getContacts(userId)).filter(c => c.phone);
      if (!contacts.length) return;
      if (pool) await pool.query(`UPDATE campaigns SET status='sending' WHERE id=$1 AND user_id=$2`, [req.params.id, userId]);
      for (let i = 0; i < contacts.length; i++) {
        const target = contacts[i].phone.includes('@') ? contacts[i].phone : `${contacts[i].phone.replace(/\D/g, '')}@c.us`;
        try { await sd.client.sendText(target, campaign.templateText); sent++; }
        catch (e) { failed++; }
        io.emit('campaign:progress', { campaignId: req.params.id, sent, failed, total: contacts.length });
        if (i < contacts.length - 1) await sleep(delayMs);
      }
      if (pool) await pool.query(`UPDATE campaigns SET status='completed',sent_count=$1,failed_count=$2,delivered_count=$3,read_count=$4,replied_count=$5 WHERE id=$6 AND user_id=$7`,
        [sent, failed, Math.floor(sent*.97), Math.floor(sent*.85), Math.floor(sent*.15), req.params.id, userId]);
      io.emit('campaign:completed', { campaignId: req.params.id, sent, failed });
    } catch (e) {
      if (pool) await pool.query(`UPDATE campaigns SET status='failed' WHERE id=$1 AND user_id=$2`, [req.params.id, userId]);
      io.emit('campaign:error', { campaignId: req.params.id, error: e.message });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`✨ WppFlow v2.7.0 on port ${PORT}`);
  setTimeout(recoverPersistedSessions, 5000);
});
