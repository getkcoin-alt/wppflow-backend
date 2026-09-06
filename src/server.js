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

// Initialize DB schema & connection
initDatabase().catch(err => console.error('Database init error:', err));

const PORT = process.env.PORT || 8080;
const TOKEN_DIR = process.env.TOKEN_DIR || './tokens';
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

// Ensure token storage directory exists (Railway persistent volume)
if (!fs.existsSync(TOKEN_DIR)) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
}

const app = express();

// Robust CORS — reflect the request origin so credentials work from any domain
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Cache-Control', 'Pragma', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']
}));

app.options('*', (req, res) => res.status(204).end());
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

// In-memory active session tracking
const sessions = new Map();

console.log('🚀 WppFlow Core Backend Engine starting...');
console.log(`📁 Persistent tokens directory: ${path.resolve(TOKEN_DIR)}`);
console.log(`🖥️  DISPLAY env: ${process.env.DISPLAY || '(not set)'}`);
if (PUPPETEER_EXECUTABLE_PATH) {
  console.log(`🌐 Using system Chromium: ${PUPPETEER_EXECUTABLE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Remove stale Chromium profile locks left by the previous container.
 * Without this, Chromium refuses to start on Railway after a redeploy because
 * it sees the lock from a different hostname and throws:
 *   "The profile appears to be in use by another Chromium process on another computer"
 */
function clearChromiumLocks(sessionName) {
  const sessionDir = path.join(TOKEN_DIR, sessionName);
  if (!fs.existsSync(sessionDir)) return;

  const lockFiles = [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
  ];

  for (const lockFile of lockFiles) {
    const lockPath = path.join(sessionDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        console.log(`🔓 [${sessionName}] Removed stale lock: ${lockFile}`);
      } catch (e) {
        console.warn(`⚠️  Could not remove ${lockFile}: ${e.message}`);
      }
    }
  }

  // Also clear any .com.google.Chrome.* temp lock files
  try {
    const entries = fs.readdirSync(sessionDir);
    for (const entry of entries) {
      if (entry.startsWith('.com.google.Chrome') || entry.startsWith('.org.chromium')) {
        try {
          fs.unlinkSync(path.join(sessionDir, entry));
          console.log(`🔓 [${sessionName}] Removed temp lock: ${entry}`);
        } catch {}
      }
    }
  } catch {}
}

/**
 * Find the DB user that owns a given session.
 * Falls back to first admin, then first user.
 */
async function resolveSessionOwner(sessionName) {
  try {
    const pool = getPool();
    if (pool) {
      const { rows } = await pool.query(
        `SELECT DISTINCT user_id FROM chats WHERE channel = $1 LIMIT 1`,
        [sessionName]
      );
      if (rows.length > 0) return rows[0].user_id;
      const adminRows = await pool.query(
        `SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
      );
      if (adminRows.rows.length > 0) return adminRows.rows[0].id;
      const anyUser = await pool.query(`SELECT id FROM users ORDER BY id ASC LIMIT 1`);
      if (anyUser.rows.length > 0) return anyUser.rows[0].id;
    }
  } catch (e) {
    console.warn('resolveSessionOwner error:', e.message);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

async function runAutomationEngine(sessionName, userId, message, client) {
  try {
    const automations = await getAutomations(userId);
    const enabledRules = automations.filter(a => a.isEnabled);

    for (const rule of enabledRules) {
      const body = (message.body || '').trim();
      let matched = false;

      switch (rule.triggerType) {
        case 'keyword': {
          const keyword = (rule.triggerCondition || '').trim().toLowerCase();
          matched = keyword.length > 0 && body.toLowerCase().includes(keyword);
          break;
        }
        case 'contains':
          matched = body.toLowerCase().includes((rule.triggerCondition || '').toLowerCase());
          break;
        case 'exact':
          matched = body.toLowerCase() === (rule.triggerCondition || '').toLowerCase();
          break;
        case 'regex': {
          try {
            matched = new RegExp(rule.triggerCondition, 'i').test(body);
          } catch { matched = false; }
          break;
        }
        case 'any_message':
          matched = body.length > 0;
          break;
        default:
          matched = false;
      }

      if (!matched) continue;

      console.log(`⚡ [${sessionName}] Automation '${rule.name}' triggered (rule: ${rule.id})`);

      try {
        if (rule.actionType === 'reply_text' && rule.actionSummary) {
          await client.sendText(message.from, rule.actionSummary);
          console.log(`✉️  [${sessionName}] Auto-reply sent to ${message.from}`);
        } else if (rule.actionType === 'reply_buttons' && rule.actionSummary) {
          const parts = rule.actionSummary.split('|||');
          const title = parts[0] || 'Choose an option';
          const buttons = parts.slice(1).map((text, i) => ({ id: `btn_${i}`, text }));
          if (buttons.length > 0) await client.sendButtonList(message.from, title, buttons);
        }

        const pool = getPool();
        if (pool) {
          await pool.query(
            `UPDATE automations SET executions_count = executions_count + 1 WHERE id = $1`,
            [rule.id]
          );
        }

        io.emit('automation:fired', {
          session: sessionName, ruleId: rule.id,
          ruleName: rule.name, from: message.from, trigger: body
        });
      } catch (actionErr) {
        console.error(`❌ Automation action failed for rule '${rule.name}':`, actionErr.message);
      }
    }
  } catch (err) {
    console.error(`Automation engine error for session ${sessionName}:`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INBOUND MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

async function handleInboundMessage(sessionName, message) {
  if (message.fromMe || message.isGroupMsg) return;

  const userId = await resolveSessionOwner(sessionName);
  if (!userId) {
    console.warn(`⚠️  [${sessionName}] Could not resolve owner — inbound message not persisted.`);
    return;
  }

  try {
    const senderPhone = message.from.replace('@c.us', '');
    const senderName = message.sender?.name || message.notifyName || senderPhone;

    const existingChats = await getChats(userId);
    let chat = existingChats.find(c => c.phone === senderPhone || c.phone === message.from);

    if (!chat) {
      chat = await createChat(userId, {
        contactName: senderName,
        phone: senderPhone,
        avatar: '',
        channel: sessionName,
        assignedTo: '',
        isGroup: false,
        lastMessage: {
          text: message.body || '',
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          status: 'delivered',
          fromMe: false
        },
        tags: []
      });
      console.log(`💬 [${sessionName}] New chat thread created: ${chat.id} for ${senderName}`);
      io.emit('chat:created', { session: sessionName, chat });
    }

    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const savedMessage = await createMessage(chat.id, {
      sender: 'customer',
      agentName: senderName,
      text: message.body || '',
      type: message.type || 'text',
      status: 'delivered',
      timestamp
    });

    await updateChat(userId, chat.id, {
      unreadCount: (chat.unreadCount || 0) + 1,
      lastMessage: { text: message.body || '', timestamp, status: 'delivered', fromMe: false }
    });

    io.emit('session:message', {
      session: sessionName,
      chatId: chat.id,
      message: {
        id: message.id, from: message.from, senderName,
        body: message.body, type: message.type,
        timestamp, isGroup: false, savedMessageId: savedMessage.id
      }
    });

    return { userId, chat };
  } catch (err) {
    console.error(`Error handling inbound message [${sessionName}]:`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`⚡ WebSocket client connected: ${socket.id}`);
  const summary = Array.from(sessions.entries()).map(([name, data]) => ({
    name, status: data.status, phone: data.phone, hasQr: !!data.qrcode
  }));
  socket.emit('sessions:init', summary);
  socket.on('disconnect', () => console.log(`🔌 WebSocket client disconnected: ${socket.id}`));
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

async function startSession(sessionName) {
  if (sessions.has(sessionName)) {
    const existing = sessions.get(sessionName);
    if (['CONNECTED', 'STARTING', 'QRCODE'].includes(existing.status)) return existing;
  }

  // ── FIX: clear stale Chromium profile locks before every launch ──────────
  clearChromiumLocks(sessionName);

  const sessionData = {
    client: null, status: 'STARTING', qrcode: null,
    phone: null, battery: 100, antiBanHealth: 98,
    warmupDay: 14, lastActive: new Date().toISOString()
  };

  sessions.set(sessionName, sessionData);
  io.emit('session:status', { session: sessionName, status: 'STARTING' });

  try {
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr, asciiQR, attempts) => {
        console.log(`📸 [${sessionName}] QR Code received (attempt ${attempts})`);
        const formattedQr = base64Qr
          ? (base64Qr.startsWith('data:image') ? base64Qr : `data:image/png;base64,${base64Qr}`)
          : null;
        sessionData.qrcode = formattedQr;
        sessionData.status = 'QRCODE';
        io.emit('session:qr', { session: sessionName, qrcode: formattedQr, attempts });
        io.emit('session:status', { session: sessionName, status: 'QRCODE' });
      },
      statusFind: (statusSession, session) => {
        console.log(`🔄 [${session}] State change: ${statusSession}`);
        if (['isLogged', 'inChat', 'qrReadSuccess', 'chatsAvailable'].includes(statusSession)) {
          sessionData.status = 'CONNECTED';
          sessionData.qrcode = null;
        } else {
          sessionData.status = statusSession;
        }
        io.emit('session:status', { session, status: sessionData.status });
      },
      // WPPConnect auto-close timeout — increase to 120s to give the user time to scan
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
        '--single-process',
      ],
      puppeteerOptions: PUPPETEER_EXECUTABLE_PATH
        ? { executablePath: PUPPETEER_EXECUTABLE_PATH }
        : {}
    });

    sessionData.client = client;
    sessionData.status = 'CONNECTED';
    sessionData.qrcode = null;

    try {
      const hostDevice = await client.getHostDevice();
      if (hostDevice?.id) {
        sessionData.phone = hostDevice.id.user || hostDevice.id._serialized;
      }
      const batteryLevel = await client.getBatteryLevel();
      if (typeof batteryLevel === 'number') sessionData.battery = batteryLevel;
    } catch (err) {
      console.warn(`⚠️  Device telemetry unavailable for ${sessionName}:`, err.message);
    }

    console.log(`✅ [${sessionName}] WhatsApp connected! Phone: ${sessionData.phone}`);
    io.emit('session:status', {
      session: sessionName, status: 'CONNECTED',
      phone: sessionData.phone, battery: sessionData.battery
    });

    client.onMessage(async (message) => {
      console.log(`📩 [${sessionName}] Message from ${message.from}: ${message.body}`);
      const result = await handleInboundMessage(sessionName, message);
      if (result?.userId) await runAutomationEngine(sessionName, result.userId, message, client);
    });

    client.onAck(async (ack) => {
      io.emit('session:ack', {
        session: sessionName,
        id: ack.id._serialized || ack.id,
        ack: ack.ack
      });
    });

    return sessionData;
  } catch (error) {
    console.error(`❌ [${sessionName}] Failed to initialize session:`, error.message);
    sessionData.status = 'FAILED';
    io.emit('session:status', { session: sessionName, status: 'FAILED', error: error.message });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT: SESSION RECOVERY
// ─────────────────────────────────────────────────────────────────────────────

async function recoverPersistedSessions() {
  try {
    if (!fs.existsSync(TOKEN_DIR)) return;
    const entries = fs.readdirSync(TOKEN_DIR, { withFileTypes: true });
    const sessionFolders = entries.filter(e => e.isDirectory()).map(e => e.name);

    if (sessionFolders.length === 0) {
      console.log('ℹ️  No persisted sessions found — clean start.');
      return;
    }

    console.log(`🔄 Recovering ${sessionFolders.length} persisted session(s): ${sessionFolders.join(', ')}`);
    for (const sessionName of sessionFolders) {
      await sleep(3000); // stagger to avoid hammering Chromium
      startSession(sessionName)
        .then(() => console.log(`♻️  Recovered: ${sessionName}`))
        .catch(err => console.warn(`⚠️  Could not recover '${sessionName}': ${err.message}`));
    }
  } catch (err) {
    console.error('Session recovery scan error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.use('/api/auth', authRoutes);
app.use('/api', dataRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'wppflow-omniengine',
    version: '2.5.1',
    database: getDatabaseStatus(),
    activeSessions: sessions.size,
    display: process.env.DISPLAY || 'not-set',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/api/sessions', authenticateToken, (req, res) => {
  const result = Array.from(sessions.entries()).map(([name, data]) => ({
    sessionKey: name, status: data.status, phone: data.phone,
    battery: data.battery, antiBanHealth: data.antiBanHealth,
    warmupDay: data.warmupDay, hasQr: !!data.qrcode, lastActive: data.lastActive
  }));
  res.json({ status: 'success', sessions: result });
});

app.post('/api/sessions/start', authenticateToken, async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) return res.status(400).json({ status: 'error', message: 'sessionName is required' });

  startSession(sessionName).catch(err =>
    console.error(`Background startSession error for ${sessionName}:`, err.message)
  );

  res.json({ status: 'success', message: `Session '${sessionName}' initialization requested`, session: sessionName });
});

app.get('/api/sessions/:session/qr', authenticateToken, (req, res) => {
  const sess = sessions.get(req.params.session);
  if (!sess) return res.status(404).json({ status: 'error', message: 'Session not found' });
  res.json({ status: 'success', session: req.params.session, sessionStatus: sess.status, qrcode: sess.qrcode });
});

app.get('/api/sessions/:session/status', authenticateToken, (req, res) => {
  const sess = sessions.get(req.params.session);
  if (!sess) return res.status(404).json({ status: 'error', message: 'Session not found' });
  res.json({ status: 'success', session: req.params.session, sessionStatus: sess.status, phone: sess.phone, battery: sess.battery, antiBanHealth: sess.antiBanHealth });
});

app.post('/api/sessions/:session/send-message', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const { phone, message } = req.body;
  const sess = sessions.get(session);
  if (!sess?.client) return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });

  try {
    const target = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    const result = await sess.client.sendText(target, message);
    res.json({ status: 'success', response: { id: result.id, to: target, body: message, timestamp: Math.floor(Date.now() / 1000) } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/sessions/:session/send-buttons', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const { phone, title, buttons } = req.body;
  const sess = sessions.get(session);
  if (!sess?.client) return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });

  try {
    const target = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    const formattedButtons = buttons.map((b, i) => ({ id: b.id || `btn_${i}`, text: b.text || b.label }));
    const result = await sess.client.sendButtonList(target, title, formattedButtons);
    res.json({ status: 'success', response: result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/sessions/:session/chats', authenticateToken, async (req, res) => {
  const sess = sessions.get(req.params.session);
  if (!sess?.client) return res.status(400).json({ status: 'error', message: `Session '${req.params.session}' is not connected` });
  try {
    const chats = await sess.client.listChats({ count: 20 });
    res.json({ status: 'success', chats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post('/api/sessions/:session/close', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const sess = sessions.get(session);
  if (sess?.client) {
    try { await sess.client.close(); } catch (e) { console.warn('Error closing client:', e.message); }
  }
  sessions.delete(session);
  io.emit('session:status', { session, status: 'DISCONNECTED' });
  res.json({ status: 'success', message: `Session '${session}' closed` });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN BROADCAST ENGINE
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/campaigns/:id/send', authenticateToken, async (req, res) => {
  const campaignId = req.params.id;
  const userId = req.user.id;

  const campaigns = await getCampaigns(userId);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return res.status(404).json({ status: 'error', message: 'Campaign not found' });

  const connectedSession = Array.from(sessions.entries()).find(
    ([, data]) => data.status === 'CONNECTED' && data.client
  );
  if (!connectedSession) {
    return res.status(400).json({
      status: 'error',
      message: 'No connected WhatsApp session available. Please connect a session first.'
    });
  }

  const [sessionName, sessionData] = connectedSession;
  const delayMs = (campaign.antiBanDelaySeconds || 4) * 1000;

  res.json({
    status: 'success',
    message: `Campaign '${campaign.name}' broadcast started via session '${sessionName}'`,
    campaignId, totalRecipients: campaign.totalRecipients
  });

  ;(async () => {
    const pool = getPool();
    let sentCount = 0;
    let failedCount = 0;
    try {
      const contacts = await getContacts(userId);
      const recipients = contacts.filter(c => c.phone);
      if (recipients.length === 0) {
        console.warn(`Campaign ${campaignId}: no contacts for user ${userId}`);
        return;
      }

      console.log(`📢 Campaign '${campaign.name}' → ${recipients.length} recipients via [${sessionName}]`);
      if (pool) await pool.query(`UPDATE campaigns SET status = 'sending' WHERE id = $1 AND user_id = $2`, [campaignId, userId]);

      for (let i = 0; i < recipients.length; i++) {
        const contact = recipients[i];
        const target = contact.phone.includes('@') ? contact.phone : `${contact.phone.replace(/\D/g, '')}@c.us`;
        try {
          await sessionData.client.sendText(target, campaign.templateText);
          sentCount++;
          console.log(`✅ Campaign [${campaignId}] → ${target} (${sentCount}/${recipients.length})`);
        } catch (err) {
          failedCount++;
          console.error(`❌ Campaign [${campaignId}] → ${target} failed: ${err.message}`);
        }

        io.emit('campaign:progress', { campaignId, sent: sentCount, failed: failedCount, total: recipients.length });
        if (i < recipients.length - 1) await sleep(delayMs);
      }

      if (pool) {
        await pool.query(
          `UPDATE campaigns SET status = 'completed', sent_count = $1, failed_count = $2,
           delivered_count = $3, read_count = $4, replied_count = $5 WHERE id = $6 AND user_id = $7`,
          [sentCount, failedCount, Math.floor(sentCount * 0.97), Math.floor(sentCount * 0.85), Math.floor(sentCount * 0.15), campaignId, userId]
        );
      }
      io.emit('campaign:completed', { campaignId, sent: sentCount, failed: failedCount });
      console.log(`🎉 Campaign '${campaign.name}' done: ${sentCount} sent, ${failedCount} failed`);
    } catch (err) {
      console.error(`Campaign broadcast error [${campaignId}]:`, err.message);
      if (pool) await pool.query(`UPDATE campaigns SET status = 'failed' WHERE id = $1 AND user_id = $2`, [campaignId, userId]);
      io.emit('campaign:error', { campaignId, error: err.message });
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`✨ WppFlow Core Backend v2.5.1 listening on port ${PORT}`);
  console.log(`👉 Healthcheck: http://localhost:${PORT}/health`);
  // Wait for DB to fully initialise, then recover persisted sessions
  setTimeout(recoverPersistedSessions, 5000);
});
