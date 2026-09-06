import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import wppconnect from '@wppconnect-team/wppconnect';
import { initDatabase, getDatabaseStatus } from './db.js';
import authRoutes from './routes/authRoutes.js';

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
// Map<sessionName, { client: any, status: string, qrcode: string, phone: string, battery: number }>
const sessions = new Map();

console.log('🚀 WppFlow Core Backend Engine starting...');
console.log(`📁 Persistent tokens directory: ${path.resolve(TOKEN_DIR)}`);
if (PUPPETEER_EXECUTABLE_PATH) {
  console.log(`🌐 Using system Chromium: ${PUPPETEER_EXECUTABLE_PATH}`);
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

/**
 * Starts or recovers a WhatsApp session using WPPConnect
 */
async function startSession(sessionName) {
  if (sessions.has(sessionName) && sessions.get(sessionName).status === 'CONNECTED') {
    return sessions.get(sessionName);
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
        sessionData.qrcode = base64Qr;
        sessionData.status = 'QRCODE';
        io.emit('session:qr', { session: sessionName, qrcode: base64Qr, attempts });
        io.emit('session:status', { session: sessionName, status: 'QRCODE' });
      },
      statusFind: (statusSession, session) => {
        console.log(`🔄 [${session}] State change: ${statusSession}`);
        sessionData.status = statusSession;
        io.emit('session:status', { session, status: statusSession });
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

    console.log(`✅ [${sessionName}] WhatsApp connected successfully! Phone: ${sessionData.phone}`);
    io.emit('session:status', { 
      session: sessionName, 
      status: 'CONNECTED',
      phone: sessionData.phone,
      battery: sessionData.battery
    });

    // Listen to incoming messages
    client.onMessage(async (message) => {
      console.log(`📩 [${sessionName}] New message from ${message.from}: ${message.body}`);
      io.emit('session:message', {
        session: sessionName,
        message: {
          id: message.id,
          from: message.from,
          senderName: message.sender?.name || message.notifyName || 'Customer',
          body: message.body,
          type: message.type,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          isGroup: message.isGroupMsg
        }
      });
    });

    // Listen to message ack (sent/delivered/read ticks)
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

// Mount Auth & User Management Routes
app.use('/api/auth', authRoutes);

// Healthcheck for Railway / Kubernetes probes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'wppflow-omniengine',
    version: '2.4.0',
    database: getDatabaseStatus(),
    activeSessions: sessions.size,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// List all managed sessions
app.get('/api/sessions', (req, res) => {
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
app.post('/api/sessions/start', async (req, res) => {
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
app.get('/api/sessions/:session/qr', (req, res) => {
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
app.get('/api/sessions/:session/status', (req, res) => {
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
app.post('/api/sessions/:session/send-message', async (req, res) => {
  const { session } = req.params;
  const { phone, message } = req.body;

  const sess = sessions.get(session);
  if (!sess || !sess.client) {
    return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });
  }

  try {
    // Format phone to WhatsApp JID
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
app.post('/api/sessions/:session/send-buttons', async (req, res) => {
  const { session } = req.params;
  const { phone, title, buttons } = req.body;

  const sess = sessions.get(session);
  if (!sess || !sess.client) {
    return res.status(400).json({ status: 'error', message: `Session '${session}' is not connected` });
  }

  try {
    const target = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@c.us`;
    // Format buttons for WPPConnect
    const formattedButtons = buttons.map(b => ({
      id: b.id || String(Math.random()),
      text: b.text || b.label
    }));

    const result = await sess.client.sendButtonList(target, title, formattedButtons);
    res.json({ status: 'success', response: result });
  } catch (error) {
    console.error(`Error sending buttons in session ${session}:`, error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// List chats
app.get('/api/sessions/:session/chats', async (req, res) => {
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
app.post('/api/sessions/:session/close', async (req, res) => {
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

server.listen(PORT, () => {
  console.log(`✨ WppFlow Core Backend listening on port ${PORT}`);
  console.log(`👉 Healthcheck: http://localhost:${PORT}/health`);
});
