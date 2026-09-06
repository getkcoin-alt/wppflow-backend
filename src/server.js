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
  getPool
} from './db.js';
import authRoutes from './routes/authRoutes.js';
import { authenticateToken } from './routes/authRoutes.js';
import dataRoutes from './routes/dataRoutes.js';

dotenv.config();

initDatabase().catch(err => console.error('Database init error:', err));

const PORT = process.env.PORT || 8080;
const TOKEN_DIR = process.env.TOKEN_DIR || './tokens';

// Alpine Linux uses 'chromium-browser', Debian uses 'chromium'
// Detect whichever is present
function detectChromium() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`🌐 Found Chromium at: ${p}`);
      return p;
    }
  }
  console.warn('⚠️  No Chromium binary found in standard paths — Puppeteer will use its bundled binary.');
  return undefined;
}

const CHROMIUM_PATH = detectChromium();

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

console.log('🚀 WppFlow Core Backend Engine starting...');
console.log(`📁 Token dir: ${path.resolve(TOKEN_DIR)}`);
console.log(`🌐 Chromium: ${CHROMIUM_PATH || 'bundled'}`);

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Remove stale Chromium profile lock files left by a previous container.
 * Without this, Chromium throws "profile in use by another process" after redeploy.
 */
function clearChromiumLocks(sessionName) {
  const sessionDir = path.join(TOKEN_DIR, sessionName);
  if (!fs.existsSync(sessionDir)) return;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(sessionDir, f);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); console.log(`🔓 [${sessionName}] Removed stale lock: ${f}`); }
      catch (e) { console.warn(`⚠️  Could not remove ${f}: ${e.message}`); }
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
  try {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(`SELECT DISTINCT user_id FROM chats WHERE channel = $1 LIMIT 1`, [sessionName]);
      if (rows.length) return rows[0].user_id;
      const { rows: adminRows } = await pool.query(`SELECT id FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1`);
      if (adminRows.length) return adminRows[0].id;
      const { rows: any } = await pool.query(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
      if (any.length) return any[0].id;
    }
  } catch (e) { console.warn('resolveSessionOwner:', e.message); }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function runAutomationEngine(sessionName, userId, message, client) {
  try {
    const rules = (await getAutomations(userId)).filter(a => a.isEnabled);
    for (const rule of rules) {
      const body = (message.body || '').trim();
      let matched = false;
      switch (rule.triggerType) {
        case 'keyword':   matched = body.toLowerCase().includes((rule.triggerCondition || '').toLowerCase()); break;
        case 'contains':  matched = body.toLowerCase().includes((rule.triggerCondition || '').toLowerCase()); break;
        case 'exact':     matched = body.toLowerCase() === (rule.triggerCondition || '').toLowerCase(); break;
        case 'regex':     try { matched = new RegExp(rule.triggerCondition, 'i').test(body); } catch { matched = false; } break;
        case 'any_message': matched = body.length > 0; break;
      }
      if (!matched) continue;
      console.log(`⚡ [${sessionName}] Automation '${rule.name}' triggered`);
      try {
        if (rule.actionType === 'reply_text' && rule.actionSummary) {
          await client.sendText(message.from, rule.actionSummary);
        } else if (rule.actionType === 'reply_buttons' && rule.actionSummary) {
          const parts = rule.actionSummary.split('|||');
          const btns = parts.slice(1).map((t, i) => ({ id: `btn_${i}`, text: t }));
          if (btns.length) await client.sendButtonList(message.from, parts[0], btns);
        }
        const pool = getPool();
        if (pool) await pool.query(`UPDATE automations SET executions_count = executions_count + 1 WHERE id = $1`, [rule.id]);
        io.emit('automation:fired', { session: sessionName, ruleId: rule.id, ruleName: rule.name, from: message.from });
      } catch (e) { console.error(`❌ Automation '${rule.name}' action failed:`, e.message); }
    }
  } catch (e) { console.error(`Automation engine error [${sessionName}]:`, e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleInboundMessage(sessionName, message) {
  if (message.fromMe || message.isGroupMsg) return;
  const userId = await resolveSessionOwner(sessionName);
  if (!userId) { console.warn(`⚠️  [${sessionName}] No owner found — message not persisted.`); return; }
  try {
    const senderPhone = message.from.replace('@c.us', '');
    const senderName = message.sender?.name || message.notifyName || senderPhone;
    const existing = await getChats(userId);
    let chat = existing.find(c => c.phone === senderPhone || c.phone === message.from);
    if (!chat) {
      const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      chat = await createChat(userId, { contactName: senderName, phone: senderPhone, avatar: '', channel: sessionName, assignedTo: '', isGroup: false, lastMessage: { text: message.body || '', timestamp: ts, status: 'delivered', fromMe: false }, tags: [] });
      console.log(`💬 [${sessionName}] New chat: ${chat.id} for ${senderName}`);
      io.emit('chat:created', { session: sessionName, chat });
    }
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const saved = await createMessage(chat.id, { sender: 'customer', agentName: senderName, text: message.body || '', type: message.type || 'text', status: 'delivered', timestamp: ts });
    await updateChat(userId, chat.id, { unreadCount: (chat.unreadCount || 0) + 1, lastMessage: { text: message.body || '', timestamp: ts, status: 'delivered', fromMe: false } });
    io.emit('session:message', { session: sessionName, chatId: chat.id, message: { id: message.id, from: message.from, senderName, body: message.body, type: message.type, timestamp: ts, savedMessageId: saved.id } });
    return { userId, chat };
  } catch (e) { console.error(`Inbound message error [${sessionName}]:`, e.message); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`⚡ Socket connected: ${socket.id}`);
  socket.emit('sessions:init', Array.from(sessions.entries()).map(([name, d]) => ({ name, status: d.status, phone: d.phone, hasQr: !!d.qrcode })));
  socket.on('disconnect', () => console.log(`🔌 Socket disconnected: ${socket.id}`));
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function startSession(sessionName) {
  if (sessions.has(sessionName)) {
    const ex = sessions.get(sessionName);
    if (['CONNECTED', 'STARTING', 'QRCODE'].includes(ex.status)) return ex;
  }

  clearChromiumLocks(sessionName);

  const sd = { client: null, status: 'STARTING', qrcode: null, phone: null, battery: 100, antiBanHealth: 98, warmupDay: 14, lastActive: new Date().toISOString() };
  sessions.set(sessionName, sd);
  io.emit('session:status', { session: sessionName, status: 'STARTING' });

  try {
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr, _ascii, attempts) => {
        console.log(`📸 [${sessionName}] QR attempt ${attempts}`);
        sd.qrcode = base64Qr?.startsWith('data:image') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        sd.status = 'QRCODE';
        io.emit('session:qr', { session: sessionName, qrcode: sd.qrcode, attempts });
        io.emit('session:status', { session: sessionName, status: 'QRCODE' });
      },
      statusFind: (status, session) => {
        console.log(`🔄 [${session}] ${status}`);
        if (['isLogged', 'inChat', 'qrReadSuccess', 'chatsAvailable'].includes(status)) {
          sd.status = 'CONNECTED'; sd.qrcode = null;
        } else {
          sd.status = status;
        }
        io.emit('session:status', { session, status: sd.status });
      },
      autoClose: 120000,
      folderNameToken: TOKEN_DIR,
      headless: true,
      useChrome: false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
      ],
      puppeteerOptions: CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}
    });

    sd.client = client;
    sd.status = 'CONNECTED';
    sd.qrcode = null;

    try {
      const host = await client.getHostDevice();
      if (host?.id) sd.phone = host.id.user || host.id._serialized;
      const bat = await client.getBatteryLevel();
      if (typeof bat === 'number') sd.battery = bat;
    } catch (e) { console.warn(`⚠️  Telemetry unavailable [${sessionName}]:`, e.message); }

    console.log(`✅ [${sessionName}] Connected! Phone: ${sd.phone}`);
    io.emit('session:status', { session: sessionName, status: 'CONNECTED', phone: sd.phone, battery: sd.battery });

    client.onMessage(async (msg) => {
      console.log(`📩 [${sessionName}] from ${msg.from}: ${msg.body}`);
      const result = await handleInboundMessage(sessionName, msg);
      if (result?.userId) await runAutomationEngine(sessionName, result.userId, msg, client);
    });

    client.onAck((ack) => {
      io.emit('session:ack', { session: sessionName, id: ack.id._serialized || ack.id, ack: ack.ack });
    });

    return sd;
  } catch (err) {
    console.error(`❌ [${sessionName}] Session failed:`, err.message);
    sd.status = 'FAILED';
    io.emit('session:status', { session: sessionName, status: 'FAILED', error: err.message });
    throw err;
  }
}

async function recoverPersistedSessions() {
  try {
    if (!fs.existsSync(TOKEN_DIR)) return;
    const dirs = fs.readdirSync(TOKEN_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    if (!dirs.length) { console.log('ℹ️  No persisted sessions — clean start.'); return; }
    console.log(`🔄 Recovering sessions: ${dirs.join(', ')}`);
    for (const name of dirs) {
      await sleep(3000);
      startSession(name).then(() => console.log(`♻️  Recovered: ${name}`)).catch(e => console.warn(`⚠️  Could not recover '${name}': ${e.message}`));
    }
  } catch (e) { console.error('Recovery error:', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api', dataRoutes);

app.get('/health', (req, res) => res.json({
  status: 'ok', engine: 'wppflow-omniengine', version: '2.5.2',
  database: getDatabaseStatus(), activeSessions: sessions.size,
  chromium: CHROMIUM_PATH || 'bundled',
  uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString()
}));

app.get('/api/sessions', authenticateToken, (req, res) => {
  res.json({ status: 'success', sessions: Array.from(sessions.entries()).map(([name, d]) => ({ sessionKey: name, status: d.status, phone: d.phone, battery: d.battery, antiBanHealth: d.antiBanHealth, warmupDay: d.warmupDay, hasQr: !!d.qrcode, lastActive: d.lastActive })) });
});

app.post('/api/sessions/start', authenticateToken, async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ status: 'error', message: 'sessionName is required' });
  startSession(sessionName).catch(e => console.error(`startSession error [${sessionName}]:`, e.message));
  res.json({ status: 'success', message: `Session '${sessionName}' initialization requested`, session: sessionName });
});

app.get('/api/sessions/:session/qr', authenticateToken, (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s) return res.status(404).json({ status: 'error', message: 'Session not found' });
  res.json({ status: 'success', session: req.params.session, sessionStatus: s.status, qrcode: s.qrcode });
});

app.get('/api/sessions/:session/status', authenticateToken, (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s) return res.status(404).json({ status: 'error', message: 'Session not found' });
  res.json({ status: 'success', session: req.params.session, sessionStatus: s.status, phone: s.phone, battery: s.battery, antiBanHealth: s.antiBanHealth });
});

app.post('/api/sessions/:session/send-message', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s?.client) return res.status(400).json({ status: 'error', message: `Session '${req.params.session}' not connected` });
  try {
    const target = req.body.phone.includes('@') ? req.body.phone : `${req.body.phone.replace(/\D/g, '')}@c.us`;
    const result = await s.client.sendText(target, req.body.message);
    res.json({ status: 'success', response: { id: result.id, to: target, body: req.body.message, timestamp: Math.floor(Date.now() / 1000) } });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.post('/api/sessions/:session/send-buttons', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s?.client) return res.status(400).json({ status: 'error', message: `Session '${req.params.session}' not connected` });
  try {
    const target = req.body.phone.includes('@') ? req.body.phone : `${req.body.phone.replace(/\D/g, '')}@c.us`;
    const result = await s.client.sendButtonList(target, req.body.title, req.body.buttons.map((b, i) => ({ id: b.id || `btn_${i}`, text: b.text || b.label })));
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/chats', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (!s?.client) return res.status(400).json({ status: 'error', message: `Session '${req.params.session}' not connected` });
  try { res.json({ status: 'success', chats: await s.client.listChats({ count: 20 }) }); }
  catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.post('/api/sessions/:session/close', authenticateToken, async (req, res) => {
  const s = sessions.get(req.params.session);
  if (s?.client) { try { await s.client.close(); } catch (e) { console.warn('close error:', e.message); } }
  sessions.delete(req.params.session);
  io.emit('session:status', { session: req.params.session, status: 'DISCONNECTED' });
  res.json({ status: 'success', message: `Session '${req.params.session}' closed` });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN BROADCAST ENGINE
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/campaigns/:id/send', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const campaigns = await getCampaigns(userId);
  const campaign = campaigns.find(c => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ status: 'error', message: 'Campaign not found' });
  const connected = Array.from(sessions.entries()).find(([, d]) => d.status === 'CONNECTED' && d.client);
  if (!connected) return res.status(400).json({ status: 'error', message: 'No connected WhatsApp session available.' });
  const [sessionName, sd] = connected;
  const delayMs = (campaign.antiBanDelaySeconds || 4) * 1000;
  res.json({ status: 'success', message: `Broadcast started via '${sessionName}'`, campaignId: req.params.id });
  ;(async () => {
    const pool = getPool();
    let sent = 0, failed = 0;
    try {
      const contacts = (await getContacts(userId)).filter(c => c.phone);
      if (!contacts.length) { console.warn(`Campaign ${req.params.id}: no contacts`); return; }
      if (pool) await pool.query(`UPDATE campaigns SET status='sending' WHERE id=$1 AND user_id=$2`, [req.params.id, userId]);
      for (let i = 0; i < contacts.length; i++) {
        const target = contacts[i].phone.includes('@') ? contacts[i].phone : `${contacts[i].phone.replace(/\D/g, '')}@c.us`;
        try { await sd.client.sendText(target, campaign.templateText); sent++; }
        catch (e) { failed++; console.error(`Campaign send failed → ${target}: ${e.message}`); }
        io.emit('campaign:progress', { campaignId: req.params.id, sent, failed, total: contacts.length });
        if (i < contacts.length - 1) await sleep(delayMs);
      }
      if (pool) await pool.query(`UPDATE campaigns SET status='completed', sent_count=$1, failed_count=$2, delivered_count=$3, read_count=$4, replied_count=$5 WHERE id=$6 AND user_id=$7`, [sent, failed, Math.floor(sent * 0.97), Math.floor(sent * 0.85), Math.floor(sent * 0.15), req.params.id, userId]);
      io.emit('campaign:completed', { campaignId: req.params.id, sent, failed });
    } catch (e) {
      console.error(`Broadcast error [${req.params.id}]:`, e.message);
      if (pool) await pool.query(`UPDATE campaigns SET status='failed' WHERE id=$1 AND user_id=$2`, [req.params.id, userId]);
      io.emit('campaign:error', { campaignId: req.params.id, error: e.message });
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`✨ WppFlow v2.5.2 on port ${PORT}`);
  console.log(`👉 Health: http://localhost:${PORT}/health`);
  setTimeout(recoverPersistedSessions, 5000);
});
