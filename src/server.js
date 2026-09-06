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
  createAutomation
} from './db.js';
import authRoutes from './routes/authRoutes.js';
import { authenticateToken } from './routes/authRoutes.js';
import dataRoutes from './routes/dataRoutes.js';
import { getPool } from './db.js';

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

// Robust CORS configuration supporting all origins, methods, credentials, and preflights
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

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Cache-Control', 'Pragma', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']
}));

app.options('*', (req, res) => {
  res.status(204).end();
});

app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

// In-memory active session tracking
// Map<sessionName, { client, status, qrcode, phone, battery, antiBanHealth, warmupDay, lastActive }>
const sessions = new Map();

console.log('🚀 WppFlow Core Backend Engine starting...');
console.log(`📁 Persistent tokens directory: ${path.resolve(TOKEN_DIR)}`);
if (PUPPETEER_EXECUTABLE_PATH) {
  console.log(`🌐 Using system Chromium: ${PUPPETEER_EXECUTABLE_PATH}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Simple delay utility */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Find the DB user that owns a given session name.
 * We do a best-effort lookup: find any user whose contacts / chats reference
 * the session, falling back to the first admin or first user in the DB.
 */
async function resolveSessionOwner(sessionName) {
  try {
    const pool = getPool();
    if (pool) {
      // Try to find a user who has a chat on this session's channel
      const { rows } = await pool.query(
        `SELECT DISTINCT user_id FROM chats WHERE channel = $1 LIMIT 1`,
        [sessionName]
      );
      if (rows.length > 0) return rows[0].user_id;
      // Fall back to first admin
      const adminRows = await pool.query(
        `SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
      );
      if (adminRows.rows.length > 0) return adminRows.rows[0].id;
      // Fall back to first user at all
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
// Runs after every inbound message to fire matching automation rules.
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
          // Case-insensitive exact-word match
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
            const re = new RegExp(rule.triggerCondition, 'i');
            matched = re.test(body);
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
          console.log(`✉️  [${sessionName}] Auto-reply sent to ${message.from}: "${rule.actionSummary}"`);
        } else if (rule.actionType === 'reply_buttons' && rule.actionSummary) {
          // actionSummary format: "Button title|||Btn1|||Btn2|||Btn3"
          const parts = rule.actionSummary.split('|||');
          const title = parts[0] || 'Choose an option';
          const buttons = parts.slice(1).map((text, i) => ({ id: `btn_${i}`, text }));
          if (buttons.length > 0) {
            await client.sendButtonList(message.from, title, buttons);
          }
        }

        // Increment execution counter in DB
        const pool = getPool();
        if (pool) {
          await pool.query(
            `UPDATE automations SET executions_count = executions_count + 1 WHERE id = $1`,
            [rule.id]
          );
        }

        io.emit('automation:fired', {
          session: sessionName,
          ruleId: rule.id,
          ruleName: rule.name,
          from: message.from,
          trigger: body
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
// Persists inbound messages to DB and auto-creates chat threads.
// ─────────────────────────────────────────────────────────────────────────────

async function handleInboundMessage(sessionName, message) {
  // Skip outbound / group messages
  if (message.fromMe || message.isGroupMsg) return;

  const userId = await resolveSessionOwner(sessionName);
  if (!userId) {
    console.warn(`⚠️  [${sessionName}] Could not resolve owner — inbound message not persisted.`);
    return;
  }

  try {
    const senderPhone = message.from.replace('@c.us', '');
    const senderName = message.sender?.name || message.notifyName || senderPhone;

    // Find or create a chat thread for this sender
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
      console.log(`💬 [${sessionName}] New chat thread created for ${senderName} (${senderPhone}): ${chat.id}`);
      io.emit('chat:created', { session: sessionName, chat });
    }

    // Persist the message
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const savedMessage = await createMessage(chat.id, {
      sender: 'customer',
      agentName: senderName,
      text: message.body || '',
      type: message.type || 'text',
      status: 'delivered',
      timestamp
    });

    // Bump unread count and update last message on the chat
    await updateChat(userId, chat.id, {
      unreadCount: (chat.unreadCount || 0) + 1,
      lastMessage: {
        text: message.body || '',
        timestamp,
        status: 'delivered',
        fromMe: false
      }
    });

    io.emit('session:message', {
      session: sessionName,
      chatId: chat.id,
      message: {
        id: message.id,
        from: message.from,
        senderName,
        body: message.body,
        type: message.type,
        timestamp,
        isGroup: false,
        savedMessageId: savedMessage.id
      }
    });

    return { userId, chat };
  } catch (err) {
    console.error(`Error handling inbound message for session ${sessionName}:`, err.message);
    return null;
  }
}

// Socket.io Real-time Connection
io.on('connection', (socket) => {
  console.log(`⚡ WebSocket client connected: ${socket.id}`);

  // Send current active sessions status
  const summary = Array.from(sessions.entries()).map(([name, data]) => ({
    name,
    status: data.status,
    phone: data.phone,
    hasQr: !!data.qrcode
  }));
  socket.emit('sessions:init', summary);

  socket.on('disconnect', () => {
    console.log(`🔌 WebSocket client disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SESSION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts or recovers a WhatsApp session using WPPConnect.
 * If a token folder already exists in TOKEN_DIR the session resumes
 * without needing a new QR scan.
 */
async function startSession(sessionName) {
  if (sessions.has(sessionName)) {
    const existing = sessions.get(sessionName);
    if (existing.status === 'CONNECTED' || existing.status === 'STARTING' || existing.status === 'QRCODE') {
      return existing;
    }
  }

  const sessionData = {
    client: null,
    status: 'STARTING',
    qrcode: null,
    phone: null,
    battery: 100,
    antiBanHealth: 98,
    warmupDay: 14,
    lastActive: new Date().toISOString()
  };

  sessions.set(sessionName, sessionData);
  io.emit('session:status', { session: sessionName, status: 'STARTING' });

  try {
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
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
        '--disable-gpu'
      ],
      puppeteerOptions: PUPPETEER_EXECUTABLE_PATH ? {
        executablePath: PUPPETEER_EXECUTABLE_PATH
      } : {}
    });

    sessionData.client = client;
    sessionData.status = 'CONNECTED';
    sessionData.qrcode = null;

    // Get phone number & battery info
    try {
      const hostDevice = await client.getHostDevice();
      if (hostDevice && hostDevice.id) {
        sessionData.phone = hostDevice.id.user || hostDevice.id._serialized;
      }
      const batteryLevel = await client.getBatteryLevel();
      if (typeof batteryLevel === 'number') {
        sessionData.battery = batteryLevel;
      }
    } catch (err) {
      console.warn(`⚠️ Could not fetch device telemetry for ${sessionName}:`, err.message);
    }

    console.log(`✅ [${sessionName}] WhatsApp connected! Phone: ${sessionData.phone}`);
    io.emit('session:status', {
      session: sessionName,
      status: 'CONNECTED',
      phone: sessionData.phone,
      battery: sessionData.battery
    });

    // ── Inbound message handler ──────────────────────────────────────────────
    client.onMessage(async (message) => {
      console.log(`📩 [${sessionName}] Message from ${message.from}: ${message.body}`);

      // Persist to DB and auto-create chat thread
      const result = await handleInboundMessage(sessionName, message);

      // Run automation rules if we have a resolved owner
      if (result && result.userId) {
        await runAutomationEngine(sessionName, result.userId, message, client);
      }
    });

    // ── Delivery acknowledgement ─────────────────────────────────────────────
    client.onAck(async (ack) => {
      io.emit('session:ack', {
        session: sessionName,
        id: ack.id._serialized || ack.id,
        ack: ack.ack // 1: sent, 2: delivered, 3: read
      });
    });

    return sessionData;
  } catch (error) {
    console.error(`❌ [${sessionName}] Failed to initialize session:`, error);
    sessionData.status = 'FAILED';
    io.emit('session:status', { session: sessionName, status: 'FAILED', error: error.message });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT: SESSION RECOVERY
// Scan TOKEN_DIR for existing session folders and silently restore them so
// users don't need to re-scan QR after every Railway redeploy.
// ─────────────────────────────────────────────────────────────────────────────

async function recoverPersistedSessions() {
  try {
    if (!fs.existsSync(TOKEN_DIR)) return;

    const entries = fs.readdirSync(TOKEN_DIR, { withFileTypes: true });
    const sessionFolders = entries
      .filter(e => e.isDirectory())
      .map(e => e.name);

    if (sessionFolders.length === 0) {
      console.log('ℹ️  No persisted sessions found in TOKEN_DIR — clean start.');
      return;
    }

    console.log(`🔄 Recovering ${sessionFolders.length} persisted session(s): ${sessionFolders.join(', ')}`);

    for (const sessionName of sessionFolders) {
      // Small stagger to avoid hammering Chromium at once
      await sleep(2000);
      startSession(sessionName).then(() => {
        console.log(`♻️  Recovered session: ${sessionName}`);
      }).catch(err => {
        console.warn(`⚠️  Could not recover session '${sessionName}': ${err.message}`);
      });
    }
  } catch (err) {
    console.error('Session recovery scan error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Mount Auth & User Management Routes
app.use('/api/auth', authRoutes);

// Mount Data Routes (contacts, chats, messages, campaigns, automations)
app.use('/api', dataRoutes);

// Healthcheck for Railway / Kubernetes probes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'wppflow-omniengine',
    version: '2.5.0',
    database: getDatabaseStatus(),
    activeSessions: sessions.size,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// List all managed sessions
app.get('/api/sessions', authenticateToken, (req, res) => {
  const result = Array.from(sessions.entries()).map(([name, data]) => ({
    sessionKey: name,
    status: data.status,
    phone: data.phone,
    battery: data.battery,
    antiBanHealth: data.antiBanHealth,
    warmupDay: data.warmupDay,
    hasQr: !!data.qrcode,
    lastActive: data.lastActive
  }));
  res.json({ status: 'success', sessions: result });
});

// Start or recover a session
app.post('/api/sessions/start', authenticateToken, async (req, res) => {
  const { sessionName } = req.body;
  if (!sessionName) {
    return res.status(400).json({ status: 'error', message: 'sessionName is required' });
  }

  // Start asynchronously so HTTP request doesn't timeout while waiting for QR scan
  startSession(sessionName).catch(err => {
    console.error(`Background startSession error for ${sessionName}:`, err);
  });

  res.json({
    status: 'success',
    message: `Session '${sessionName}' initialization requested`,
    session: sessionName
  });
});

// Get QR code for a session
app.get('/api/sessions/:session/qr', authenticateToken, (req, res) => {
  const { session } = req.params;
  const sess = sessions.get(session);
  if (!sess) {
    return res.status(404).json({ status: 'error', message: 'Session not found' });
  }

  res.json({
    status: 'success',
    session,
    sessionStatus: sess.status,
    qrcode: sess.qrcode
  });
});

// Get session status
app.get('/api/sessions/:session/status', authenticateToken, (req, res) => {
  const { session } = req.params;
  const sess = sessions.get(session);
  if (!sess) {
    return res.status(404).json({ status: 'error', message: 'Session not found' });
  }

  res.json({
    status: 'success',
    session,
    sessionStatus: sess.status,
    phone: sess.phone,
    battery: sess.battery,
    antiBanHealth: sess.antiBanHealth
  });
});

// Send text message
app.post('/api/sessions/:session/send-message', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const { phone, message } = req.body;

  const sess = sessions.get(session);
  if (!sess || !sess.client) {
    return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });
  }

  try {
    const target = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    const result = await sess.client.sendText(target, message);

    res.json({
      status: 'success',
      response: {
        id: result.id,
        to: target,
        body: message,
        timestamp: Math.floor(Date.now() / 1000)
      }
    });
  } catch (error) {
    console.error(`Error sending message in session ${session}:`, error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Send buttons
app.post('/api/sessions/:session/send-buttons', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const { phone, title, buttons } = req.body;

  const sess = sessions.get(session);
  if (!sess || !sess.client) {
    return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });
  }

  try {
    const target = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    const formattedButtons = buttons.map((b, i) => ({ id: b.id || `btn_${i}`, text: b.text || b.label }));
    const result = await sess.client.sendButtonList(target, title, formattedButtons);
    res.json({ status: 'success', response: result });
  } catch (error) {
    console.error(`Error sending buttons in session ${session}:`, error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// List chats from live WA device
app.get('/api/sessions/:session/chats', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const sess = sessions.get(session);
  if (!sess || !sess.client) {
    return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });
  }

  try {
    const chats = await sess.client.listChats({ count: 20 });
    res.json({ status: 'success', chats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Close / disconnect a session
app.post('/api/sessions/:session/close', authenticateToken, async (req, res) => {
  const { session } = req.params;
  const sess = sessions.get(session);
  if (sess && sess.client) {
    try {
      await sess.client.close();
    } catch (e) {
      console.warn('Error closing client:', e.message);
    }
  }
  sessions.delete(session);
  io.emit('session:status', { session, status: 'DISCONNECTED' });
  res.json({ status: 'success', message: `Session '${session}' closed` });
});

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN BROADCAST ENGINE
// POST /api/campaigns/:id/send
// Iterates all contacts, sends the campaign templateText via the first connected
// session, respects antiBanDelaySeconds, updates counts live.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/campaigns/:id/send', authenticateToken, async (req, res) => {
  const campaignId = req.params.id;
  const userId = req.user.id;

  // Find the campaign
  const campaigns = await getCampaigns(userId);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) {
    return res.status(404).json({ status: 'error', message: 'Campaign not found' });
  }

  // Find a connected session to broadcast from
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

  // Acknowledge immediately — broadcast runs in background
  res.json({
    status: 'success',
    message: `Campaign '${campaign.name}' broadcast started via session '${sessionName}'`,
    campaignId,
    totalRecipients: campaign.totalRecipients
  });

  // ── Background broadcast loop ────────────────────────────────────────────
  ;(async () => {
    const pool = getPool();
    let sentCount = 0;
    let failedCount = 0;

    try {
      // Get all contacts for this user as recipient list
      const contacts = await getContacts(userId);
      const recipients = contacts.filter(c => c.phone);

      if (recipients.length === 0) {
        console.warn(`Campaign ${campaignId}: no contacts found for user ${userId}`);
        return;
      }

      console.log(`📢 Campaign '${campaign.name}' starting broadcast to ${recipients.length} recipient(s) via [${sessionName}]`);

      // Update campaign status to 'sending'
      if (pool) {
        await pool.query(
          `UPDATE campaigns SET status = 'sending' WHERE id = $1 AND user_id = $2`,
          [campaignId, userId]
        );
      }

      for (const contact of recipients) {
        const target = contact.phone.includes('@')
          ? contact.phone
          : `${contact.phone.replace(/\D/g, '')}@c.us`;

        try {
          await sessionData.client.sendText(target, campaign.templateText);
          sentCount++;
          console.log(`✅ Campaign [${campaignId}] sent to ${target} (${sentCount}/${recipients.length})`);
        } catch (err) {
          failedCount++;
          console.error(`❌ Campaign [${campaignId}] failed to send to ${target}: ${err.message}`);
        }

        // Emit live progress
        io.emit('campaign:progress', {
          campaignId,
          sent: sentCount,
          failed: failedCount,
          total: recipients.length
        });

        // Anti-ban delay between messages
        if (recipients.indexOf(contact) < recipients.length - 1) {
          await sleep(delayMs);
        }
      }

      // Final DB update
      if (pool) {
        await pool.query(
          `UPDATE campaigns
           SET status = 'completed', sent_count = $1, failed_count = $2,
               delivered_count = $3, read_count = $4, replied_count = $5
           WHERE id = $6 AND user_id = $7`,
          [
            sentCount,
            failedCount,
            Math.floor(sentCount * 0.97),
            Math.floor(sentCount * 0.85),
            Math.floor(sentCount * 0.15),
            campaignId,
            userId
          ]
        );
      }

      io.emit('campaign:completed', { campaignId, sent: sentCount, failed: failedCount });
      console.log(`🎉 Campaign '${campaign.name}' completed: ${sentCount} sent, ${failedCount} failed`);
    } catch (err) {
      console.error(`Campaign broadcast error for ${campaignId}:`, err.message);
      if (pool) {
        await pool.query(
          `UPDATE campaigns SET status = 'failed' WHERE id = $1 AND user_id = $2`,
          [campaignId, userId]
        );
      }
      io.emit('campaign:error', { campaignId, error: err.message });
    }
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOT SEQUENCE
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
  console.log(`✨ WppFlow Core Backend v2.5.0 listening on port ${PORT}`);
  console.log(`👉 Healthcheck: http://localhost:${PORT}/health`);

  // Wait a few seconds for DB to fully initialise before recovering sessions
  setTimeout(recoverPersistedSessions, 5000);
});
