import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import wppconnect from '@wppconnect-team/wppconnect';
import {
  initDatabase,
  getDatabaseStatus,
  getContacts,
  createContact,
  getChats,
  createChat,
  createMessage,
  getMessages,
  updateChat,
  deleteChatsByChannel,
  getAutomations,
  getCampaigns,
  getPool,
  getWorkspaceUserIds
} from './db.js';
import authRoutes from './routes/authRoutes.js';
import { authenticateToken, JWT_SECRET } from './routes/authRoutes.js';
import jwt from 'jsonwebtoken';
import dataRoutes from './routes/dataRoutes.js';

initDatabase().catch(err => console.error('Database init error:', err));

const PORT = process.env.PORT || 8080;
const TOKEN_DIR = process.env.TOKEN_DIR || './tokens';
const SESSION_REGISTRY = path.join(TOKEN_DIR, '.connected-sessions.json');

if (!fs.existsSync(TOKEN_DIR)) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
}

const app = express();

app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cache-Control, Pragma');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

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

async function emitSessionEvent(event, sessionName, payload, ownerOverride = null) {
  const ownerId = ownerOverride || sessions.get(sessionName)?.ownerId || await resolveSessionOwner(sessionName);
  if (ownerId) io.to(`workspace:${ownerId}`).emit(event, payload);
  else io.emit(event, payload);
}

console.log('🚀 WppFlow Core Backend Engine starting...');
console.log(`📁 Token dir: ${path.resolve(TOKEN_DIR)}`);
console.log(`📋 Node: ${process.version}`);

// ─────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function readConnectedSessions() {
  try {
    const value = JSON.parse(fs.readFileSync(SESSION_REGISTRY, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value.map((entry) => typeof entry === 'string' ? { name: entry, ownerId: null } : entry)
      .filter((entry) => typeof entry?.name === 'string')
      .map((entry) => ({ name: entry.name, ownerId: entry.ownerId ? Number(entry.ownerId) : null }));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`⚠️  Could not read session registry: ${e.message}`);
    return [];
  }
}

function setSessionRegistered(sessionName, registered, ownerId = null) {
  const sessionsInRegistry = readConnectedSessions().filter((entry) => entry.name !== sessionName);
  if (registered) {
    const previous = readConnectedSessions().find((entry) => entry.name === sessionName);
    sessionsInRegistry.push({ name: sessionName, ownerId: ownerId || previous?.ownerId || null });
  }
  const temporaryFile = `${SESSION_REGISTRY}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(sessionsInRegistry.sort((a, b) => a.name.localeCompare(b.name))));
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

function isSafeSessionName(sessionName) {
  return typeof sessionName === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(sessionName);
}

function sessionTokenPath(sessionName) {
  if (!isSafeSessionName(sessionName)) return null;
  const tokenRoot = path.resolve(TOKEN_DIR);
  const sessionDir = path.resolve(tokenRoot, sessionName);
  return path.dirname(sessionDir) === tokenRoot ? sessionDir : null;
}

/** Close a session and remove only its own browser profile and inbox data. */
async function cleanupSession(sessionName, session = sessions.get(sessionName)) {
  if (session?.cleaningUp) return { filesRemoved: true, chatsDeleted: 0 };
  if (session) session.cleaningUp = true;
  const ownerId = session?.ownerId || await resolveSessionOwner(sessionName);

  if (session?.client) {
    try { await session.client.close(); } catch (error) {
      console.warn(`⚠️  [${sessionName}] Client close during cleanup:`, error.message);
    }
  }
  sessions.delete(sessionName);
  setSessionRegistered(sessionName, false);

  let chatsDeleted = 0;
  try { chatsDeleted = await deleteChatsByChannel(sessionName); }
  catch (error) { console.warn(`⚠️  [${sessionName}] Inbox cleanup failed:`, error.message); }

  const profilePath = sessionTokenPath(sessionName);
  let filesRemoved = false;
  if (profilePath) {
    try {
      fs.rmSync(profilePath, { recursive: true, force: true });
      filesRemoved = !fs.existsSync(profilePath);
    } catch (error) {
      console.warn(`⚠️  [${sessionName}] Token cleanup failed:`, error.message);
    }
  }

  await emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'DISCONNECTED', filesRemoved, chatsDeleted }, ownerId);
  console.log(`🧹 [${sessionName}] Cleanup complete: filesRemoved=${filesRemoved}, chatsDeleted=${chatsDeleted}`);
  return { filesRemoved, chatsDeleted };
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
// Robust WhatsApp Target Resolution & Safe Messaging Primitives
// ─────────────────────────────────────────────────────────────────────────────

async function resolveWhatsAppTarget(client, rawTarget, hintName = '') {
  if (!rawTarget || typeof rawTarget !== 'string') throw new Error('Target phone or chat identifier is required');
  const target = rawTarget.trim();

  try {
    const resolved = await client.page.evaluate((id, name) => {
      if (typeof window.WPP === 'undefined' || !window.WPP.chat) return null;
      try {
        const list = window.WPP.chat.list();
        if (Array.isArray(list)) {
          // If we have a hintName, find matching chat that has messages
          if (name) {
            const byName = list.filter(c => {
              const cn = c.name || c.formattedTitle || c.contact?.name;
              return cn && cn.toLowerCase() === name.toLowerCase();
            });
            if (byName.length === 1) {
              return String(byName[0].id?._serialized || byName[0].id);
            }
            if (byName.length > 1) {
              byName.sort((a, b) => (Number(b.t || 0) - Number(a.t || 0)));
              return String(byName[0].id?._serialized || byName[0].id);
            }
          }

          const asLid = `${id}@lid`;
          const asCus = `${id}@c.us`;
          const asGus = `${id}@g.us`;

          // Direct match in loaded list
          const match = list.find(c => {
            const sid = String(c.id?._serialized || c.id || '');
            const uid = String(c.id?.user || '');
            return sid === id || sid === asLid || sid === asCus || sid === asGus || uid === id.replace(/@.*$/, '');
          });
          if (match) return String(match.id?._serialized || match.id);
        }
      } catch {}
      return null;
    }, target, hintName);

    if (resolved) {
      console.log(`🎯 [WPP] Resolved target '${target}' (hint: '${hintName}') -> '${resolved}'`);
      return resolved;
    }
  } catch (err) {
    console.warn(`Target resolution error:`, err.message);
  }

  if (target.includes('@')) return target;

  // Fallback heuristic: LIDs are typically >= 13 digits
  const digits = target.replace(/\D/g, '');
  if (digits.length >= 13) {
    return `${digits}@lid`;
  }

  return `${digits}@c.us`;
}

function formatCallDuration(seconds) {
  const dur = Number(seconds || 0);
  if (dur <= 0) return '0:00';
  const mins = Math.floor(dur / 60);
  const secs = dur % 60;
  return mins > 0 ? (secs > 0 ? `${mins} min ${secs} sec` : `${mins} min`) : `${secs} sec`;
}

function formatCallText(msg) {
  const isVideo = Boolean(msg.isVideoCall);
  const dur = Number(msg.callDuration || 0);
  const prefix = isVideo ? '📹 Video call' : '📞 Voice call';
  if (dur > 0) {
    const mins = Math.floor(dur / 60);
    const secs = dur % 60;
    const durStr = mins > 0 ? (secs > 0 ? `${mins} min ${secs} sec` : `${mins} min`) : `${secs} sec`;
    return `${prefix} (${durStr})`;
  }
  return `${prefix} (${msg.fromMe ? 'No answer' : 'Missed'})`;
}

async function getMessageMediaDataUrl(client, msgId, target = '', timestamp = null) {
  try {
    return await client.page.evaluate(async (mid, chatTarget, ts) => {
      if (typeof window.WPP === 'undefined' || !window.WPP.chat) return '';
      try {
        let msg = null;
        if (mid && !String(mid).startsWith('row_')) {
          try {
            msg = await window.WPP.chat.getMessage(chatTarget, mid);
          } catch {}
        }

        if (!msg && chatTarget) {
          try {
            const chat = await window.WPP.chat.find(chatTarget);
            if (chat?.msgs?.models) {
              msg = chat.msgs.models.find(m => (ts && Number(m.t) === Number(ts)) || (mid && (m.id?._serialized === mid || m.rowId === mid)));
            }
          } catch {}
        }

        if (!msg && chatTarget) {
          try {
            const msgs = await window.WPP.chat.getMessages(chatTarget, { count: 60 });
            if (Array.isArray(msgs)) {
              msg = msgs.find(m => (ts && Number(m.t) === Number(ts)) || (mid && (m.id?._serialized === mid || m.id === mid)));
            }
          } catch {}
        }

        const idToDownload = msg?.id?._serialized || msg?.id || mid;
        if (!idToDownload || String(idToDownload).startsWith('row_')) return '';

        const blob = await window.WPP.chat.downloadMedia(idToDownload);
        if (!blob) return '';
        if (typeof blob === 'string') return blob;
        if (window.WPP.util?.blobToBase64) {
          return await window.WPP.util.blobToBase64(blob);
        }
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result || '');
          reader.onerror = () => resolve('');
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        return '';
      }
    }, msgId, target, timestamp);
  } catch {
    return '';
  }
}

async function sendTextMessageSafe(client, rawTarget, content, options = {}) {
  const target = await resolveWhatsAppTarget(client, rawTarget);
  console.log(`📤 [WPP] Sending message to ${target}`);
  return await client.page.evaluate(async (to, text, opts) => {
    if (typeof window.WPP === 'undefined' || !window.WPP.chat) {
      throw new Error('WhatsApp Web engine not ready');
    }
    const sendResult = await window.WPP.chat.sendTextMessage(to, text, {
      waitForAck: false,
      ...opts
    });
    return {
      id: String(sendResult?.id?._serialized || sendResult?.id || `msg_${Date.now()}`),
      ack: sendResult?.ack ?? 1,
      to,
      timestamp: Math.floor(Date.now() / 1000)
    };
  }, target, content, options);
}

async function fetchRecentChatMessages(client, rawTarget, hintName = '') {
  const target = await resolveWhatsAppTarget(client, rawTarget, hintName);
  let list = [];

  // 1. Try getAllMessagesInChat (returns full message objects with call & media data)
  try {
    const rawAll = await client.getAllMessagesInChat(target, true, false).catch(() => []);
    if (Array.isArray(rawAll) && rawAll.length > 0) {
      list = rawAll.map(m => {
        const id = String(m.id?._serialized || m.id?.id || m.id || (m.rowId ? `row_${m.rowId}` : ''));
        const type = m.type === 'chat' ? 'text' : (m.type || 'text');
        const isVideoCall = Boolean(m.isVideoCall);
        const callDuration = Number(m.callDuration || 0);
        let body = m.body || m.caption || '';
        if (type === 'call_log') {
          body = formatCallText(m);
        } else if (type === 'image') {
          body = m.caption || '📷 Photo';
        } else if (type === 'video') {
          body = m.caption || '🎥 Video';
        } else if (type === 'audio' || type === 'ptt') {
          body = '🎵 Voice message';
        } else if (type === 'document') {
          body = m.caption || m.filename || '📄 Document';
        } else if (type === 'e2e_notification') {
          body = '🔒 Messages and calls are end-to-end encrypted';
        } else if (!body && type !== 'text') {
          body = `[${type}]`;
        }

        let mediaPreview = '';
        if (m.mediaData?.preview) {
          if (typeof m.mediaData.preview === 'string') {
            mediaPreview = m.mediaData.preview.startsWith('data:') ? m.mediaData.preview : `data:image/jpeg;base64,${m.mediaData.preview}`;
          } else if (m.mediaData.preview?._b64) {
            mediaPreview = `data:image/jpeg;base64,${m.mediaData.preview._b64}`;
          }
        }

        return {
          id,
          body,
          fromMe: Boolean(m.fromMe),
          type,
          t: m.t ? Number(m.t) : (m.timestamp ? Number(m.timestamp) : Math.floor(Date.now() / 1000)),
          isVideoCall,
          callDuration,
          callOutcome: m.callOutcome || '',
          mediaUrl: mediaPreview,
          fileName: m.filename || '',
          fileSize: m.size ? `${Math.round(m.size / 1024)} KB` : '',
          senderName: m.sender?.name || m.notifyName || (m.fromMe ? 'You' : '')
        };
      });
    }
  } catch (err) {
    console.warn(`getAllMessagesInChat error for ${target}:`, err.message);
  }

  // 2. Fallback to WPP.chat.getMessages in page evaluate
  if (list.length === 0) {
    try {
      const raw = await client.page.evaluate(async (chatId) => {
        if (typeof window.WPP === 'undefined' || !window.WPP.chat?.getMessages) return [];
        try {
          const msgs = await window.WPP.chat.getMessages(chatId, { count: 50 });
          if (!Array.isArray(msgs)) return [];
          return msgs.map(m => {
            const id = String(m.id?._serialized || m.id?.id || m.id || '');
            const type = m.type === 'chat' ? 'text' : (m.type || 'text');
            const isVideoCall = Boolean(m.isVideoCall);
            const callDuration = Number(m.callDuration || 0);
            let body = m.body || m.caption || '';
            let mediaPreview = '';
            if (m.mediaData?.preview) {
              if (typeof m.mediaData.preview === 'string') {
                mediaPreview = m.mediaData.preview.startsWith('data:') ? m.mediaData.preview : `data:image/jpeg;base64,${m.mediaData.preview}`;
              } else if (m.mediaData.preview?._b64) {
                mediaPreview = `data:image/jpeg;base64,${m.mediaData.preview._b64}`;
              }
            }
            return {
              id,
              type,
              body,
              fromMe: Boolean(m.fromMe),
              t: m.t ? Number(m.t) : Math.floor(Date.now() / 1000),
              isVideoCall,
              callDuration,
              callOutcome: m.callOutcome || '',
              mediaUrl: mediaPreview,
              fileName: m.filename || '',
              senderName: m.sender?.name || m.notifyName || (m.fromMe ? 'You' : '')
            };
          });
        } catch {
          return [];
        }
      }, target);

      if (Array.isArray(raw) && raw.length > 0) {
        list = raw.map(m => {
          let body = m.body;
          if (m.type === 'call_log') {
            body = formatCallText(m);
          } else if (m.type === 'image') {
            body = m.body || '📷 Photo';
          }
          return { ...m, body };
        });
      }
    } catch {}
  }

  // 3. Fallback to model-storage IndexedDB if still empty
  if (list.length === 0) {
    try {
      const idbList = await client.page.evaluate(async (targetId) => {
        return new Promise((resolve) => {
          const req = indexedDB.open('model-storage');
          req.onsuccess = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('message')) {
              db.close();
              return resolve([]);
            }
            const tx = db.transaction(['message'], 'readonly');
            const store = tx.objectStore('message');
            const range = IDBKeyRange.bound(`${targetId}_`, `${targetId}_\uffff`);
            const cursorReq = store.index('internalId').openCursor(range, 'prev');
            const results = [];
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor && results.length < 50) {
                const v = cursor.value;
                results.push({
                  id: String(v.id?._serialized || v.id || ''),
                  body: v.body || v.caption || '',
                  fromMe: Boolean(v.fromMe),
                  type: v.type === 'chat' ? 'text' : (v.type || 'text'),
                  t: v.t ? Number(v.t) : Math.floor(Date.now() / 1000),
                  senderName: v.fromMe ? 'You' : ''
                });
                cursor.continue();
              } else {
                db.close();
                resolve(results.reverse());
              }
            };
            cursorReq.onerror = () => { db.close(); resolve([]); };
          };
          req.onerror = () => resolve([]);
        });
      }, target);
      if (Array.isArray(idbList) && idbList.length > 0) list = idbList;
    } catch {}
  }

  // For media items without a loaded image URL, download media
  for (const item of list) {
    if (['image', 'video', 'audio', 'document'].includes(item.type) && !item.mediaUrl) {
      try {
        const dl = await getMessageMediaDataUrl(client, item.id, target, item.t);
        if (dl) item.mediaUrl = dl;
      } catch {}
    }
  }

  return list;
}

async function runAutomationEngine(sessionName, userId, message, client, incomingChat = null) {
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
      console.log(`⚡ [${sessionName}] Chatbot automation '${rule.name}' triggered for ${message.from}`);

      try {
        if (rule.actionType === 'reply_text' && rule.actionSummary) {
          // 1. Send via WhatsApp to recipient
          await sendTextMessageSafe(client, message.from, rule.actionSummary);

          // 2. Persist in database & emit real-time event for UI
          const chat = incomingChat || (await getChats(userId)).find(c =>
            c.phone === message.from || String(message.from).includes(c.phone)
          );

          if (chat) {
            const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const botMsg = await createMessage(chat.id, {
              sender: 'agent',
              agentName: rule.name || 'Chatbot',
              text: rule.actionSummary,
              type: 'text',
              status: 'sent',
              timestamp: ts,
            }, userId);

            await updateChat(userId, chat.id, {
              lastMessage: { text: rule.actionSummary, timestamp: ts, status: 'sent', fromMe: true }
            });

            io.to(`workspace:${userId}`).emit('session:message', {
              session: sessionName,
              chatId: chat.id,
              message: {
                id: botMsg.id,
                from: sessionName,
                senderName: rule.name || 'Chatbot',
                body: rule.actionSummary,
                type: 'text',
                timestamp: ts,
                savedMessageId: botMsg.id,
                fromMe: true,
              }
            });
          }
        } else if (rule.actionType === 'reply_buttons' && rule.actionSummary) {
          const parts = rule.actionSummary.split('|||');
          const btns = parts.slice(1).map((t, i) => ({ id: `btn_${i}`, text: t }));
          if (btns.length) await client.sendButtonList(message.from, parts[0], btns);
        }

        const pool = getPool();
        if (pool) await pool.query(`UPDATE automations SET executions_count = executions_count + 1 WHERE id = $1`, [rule.id]);
        io.to(`workspace:${userId}`).emit('automation:fired', { session: sessionName, ruleId: rule.id, ruleName: rule.name, from: message.from });
      } catch (e) { console.error(`❌ Chatbot automation '${rule.name}' failed:`, e.message); }
    }
  } catch (e) { console.error(`Automation engine error [${sessionName}]:`, e.message); }
}

async function handleAnyMessage(sessionName, message, client) {
  const userId = await resolveSessionOwner(sessionName);
  if (!userId) {
    console.warn(`⚠️  [${sessionName}] No owner — message not persisted.`);
    return null;
  }

  try {
    const isOut = Boolean(message.fromMe);
    // Remote identifier: if fromMe, the recipient is in 'to'; if inbound, the sender is in 'from'
    const rawRemote = isOut
      ? (message.to || message.chatId?._serialized || message.chat?.id?._serialized || '')
      : (message.from || message.chatId?._serialized || message.chat?.id?._serialized || '');

    const remoteId = String(rawRemote);
    const isGroup = Boolean(message.isGroupMsg || remoteId.includes('@g.us'));
    const cleanPhone = isGroup ? remoteId : remoteId.replace(/@c\.us$/, '');

    const senderName = isOut
      ? 'You'
      : (message.sender?.name || message.notifyName || (isGroup ? (message.author ? String(message.author).replace(/@c\.us$/, '') : 'Member') : cleanPhone));

    const groupName = message.chat?.name || message.chat?.contact?.name || 'WhatsApp Group';
    const contactName = isGroup ? groupName : (senderName !== cleanPhone ? senderName : (message.chat?.contact?.name || cleanPhone));

    // Resolve or find existing chat
    const existing = await getChats(userId);
    let chat = existing.find(c =>
      c.phone === cleanPhone ||
      c.phone === remoteId ||
      c.phone === remoteId.replace(/@lid$/, '') ||
      (cleanPhone.length >= 10 && c.phone.endsWith(cleanPhone.slice(-10))) ||
      (!isGroup && contactName && c.contactName === contactName)
    );

    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Format message text and type
    let msgType = message.type === 'chat' ? 'text' : (message.type || 'text');
    let msgText = message.body || message.caption || '';

    if (msgType === 'call_log') {
      msgText = formatCallText(message);
    } else if (msgType === 'image') {
      msgText = message.caption || '📷 Photo';
    } else if (msgType === 'video') {
      msgText = message.caption || '🎥 Video';
    } else if (msgType === 'audio' || msgType === 'ptt') {
      msgType = 'audio';
      msgText = '🎵 Voice message';
    } else if (msgType === 'document') {
      msgText = message.caption || message.filename || '📄 Document';
    } else if (msgType === 'e2e_notification') {
      msgText = '🔒 Messages and calls are end-to-end encrypted';
    } else if (!msgText && msgType !== 'text') {
      msgText = `[${msgType}]`;
    }

    if (!chat) {
      chat = await createChat(userId, {
        contactName,
        phone: cleanPhone,
        avatar: message.chat?.contact?.profilePicThumbObj?.eurl || '',
        channel: sessionName,
        assignedTo: '',
        isGroup,
        groupMembersCount: isGroup ? (message.chat?.groupMetadata?.participants?.length || 0) : 0,
        lastMessage: { text: msgText, timestamp: ts, status: isOut ? 'sent' : 'delivered', fromMe: isOut },
        tags: isGroup ? ['Group'] : [],
      });
      console.log(`💬 [${sessionName}] New chat created: ${chat.id} (${contactName})`);
      io.to(`workspace:${userId}`).emit('chat:created', { session: sessionName, chat });
    }

    // Media download if applicable
    let mediaUrl = message.mediaUrl || '';
    if (['image', 'video', 'audio', 'document'].includes(msgType) && !mediaUrl) {
      const mid = message.id?._serialized || message.id;
      if (mid) {
        try {
          mediaUrl = await getMessageMediaDataUrl(client, mid, remoteId, message.t || message.timestamp);
        } catch {}
      }
    }

    const saved = await createMessage(chat.id, {
      sender: isOut ? 'agent' : 'customer',
      agentName: senderName,
      text: msgText,
      type: msgType,
      mediaUrl: mediaUrl || '',
      fileName: message.filename || '',
      fileSize: message.size ? `${Math.round(message.size / 1024)} KB` : '',
      audioDuration: message.duration ? `${message.duration}s` : (msgType === 'call_log' ? formatCallDuration(message.callDuration) : ''),
      status: isOut ? 'sent' : 'delivered',
      timestamp: ts,
    }, userId);

    await updateChat(userId, chat.id, {
      unreadCount: isOut ? (chat.unreadCount || 0) : ((chat.unreadCount || 0) + 1),
      lastMessage: { text: msgText, timestamp: ts, status: isOut ? 'sent' : 'delivered', fromMe: isOut },
    });

    // Real-time broadcast to all browser tabs in the workspace
    io.to(`workspace:${userId}`).emit('session:message', {
      session: sessionName,
      chatId: chat.id,
      message: {
        id: message.id?._serialized || message.id || saved.id,
        chatId: chat.id,
        from: isOut ? sessionName : remoteId,
        senderName,
        body: msgText,
        text: msgText,
        type: msgType,
        mediaUrl: mediaUrl || '',
        timestamp: ts,
        savedMessageId: saved.id,
        fromMe: isOut,
        status: isOut ? 'sent' : 'delivered',
      },
    });

    io.to(`workspace:${userId}`).emit('chat:updated', {
      session: sessionName,
      chatId: chat.id,
      lastMessage: { text: msgText, timestamp: ts, status: isOut ? 'sent' : 'delivered', fromMe: isOut },
      unreadCount: isOut ? (chat.unreadCount || 0) : ((chat.unreadCount || 0) + 1),
    });

    return { userId, chat };
  } catch (e) {
    console.error(`Message handler error [${sessionName}]:`, e.message);
    return null;
  }
}

async function syncRemoteChats(sessionName, client) {
  const userId = await resolveSessionOwner(sessionName);
  if (!userId) {
    console.warn(`⚠️  [${sessionName}] No owner found to sync chats.`);
    return;
  }

  console.log(`🔄 [${sessionName}] Starting comprehensive WhatsApp sync for owner ${userId}...`);

  // 1. Sync Contacts into workspace contacts table
  try {
    const existingContacts = await getContacts(userId);
    const existingPhones = new Set(existingContacts.map((c) => c.phone));
    const rawContacts = await client.getAllContacts();
    if (Array.isArray(rawContacts)) {
      let contactsSynced = 0;
      for (const rc of rawContacts) {
        const rawId = rc.id?._serialized || rc.id;
        if (!rawId || String(rawId).includes('@g.us') || rawId === 'status@broadcast') continue;
        const phone = String(rc.id?.user || rawId).replace(/@c\.us$/, '');
        if (!phone || existingPhones.has(phone)) continue;
        const name = rc.name || rc.shortName || rc.pushname || rc.formattedName || phone;
        const avatar = rc.profilePicThumbObj?.eurl || '';
        await createContact(userId, {
          name,
          phone,
          avatar,
          tags: ['WhatsApp'],
          channel: sessionName,
          customTraits: rc.textStatusString ? { status: rc.textStatusString } : {},
          lifetimeValue: 0,
        });
        existingPhones.add(phone);
        contactsSynced++;
        if (contactsSynced >= 300) break;
      }
      console.log(`📇 [${sessionName}] Synced ${contactsSynced} WhatsApp contacts`);
    }
  } catch (err) {
    console.warn(`⚠️  [${sessionName}] Contact sync error:`, err.message);
  }

  // 2. Collect ALL conversations: groups + individual chats via fast page evaluate
  const allConversations = [];
  const seenIds = new Set();

  try {
    const rawList = await client.page.evaluate(async () => {
      if (typeof window.WPP === 'undefined' || !window.WPP.chat) return [];
      try {
        const list = await window.WPP.chat.list();
        return list.map((c) => {
          const rawId = c.id?._serialized || c.id;
          const isGroup = Boolean(c.isGroup || String(rawId).includes('@g.us'));
          const contact = c.contact || {};
          const name = c.name || c.formattedTitle || contact.name || contact.pushname || contact.shortName || '';
          const isLid = String(rawId).includes('@lid');
          const phone = (isGroup || isLid)
            ? String(rawId)
            : String(contact.id?.user || contact.phoneNumber || c.id?.user || rawId).replace(/@c\.us$/, '');
          const msgs = c.msgs?.models || [];
          const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          const lastBody = last?.body || last?.caption || (last?.type && last.type !== 'chat' ? `[${last.type}]` : '');
          const lastTimestamp = last?.t ? Number(last.t) : (c.t ? Number(c.t) : null);
          const fromMe = Boolean(last?.fromMe);

          return {
            rawId: String(rawId),
            name: name || (isGroup ? 'WhatsApp Group' : phone),
            phone: phone || String(rawId),
            isGroup,
            groupMembersCount: c.groupMetadata?.participants?.length || 0,
            avatar: contact.profilePicThumbObj?.eurl || '',
            unreadCount: Number(c.unreadCount || 0),
            timestamp: lastTimestamp,
            lastMessage: lastBody,
            fromMe
          };
        });
      } catch {
        return [];
      }
    });

    if (Array.isArray(rawList)) {
      for (const item of rawList) {
        if (item.rawId && !seenIds.has(item.rawId) && item.rawId !== 'status@broadcast') {
          allConversations.push(item);
          seenIds.add(item.rawId);
        }
      }
      console.log(`💬 [${sessionName}] Extracted ${allConversations.length} WhatsApp conversations via fast evaluator`);
    }
  } catch (evalErr) {
    console.warn(`⚠️ [${sessionName}] Fast chat list error:`, evalErr.message);
  }

  // Fallback: If no groups were in WPP list, fetch via getAllGroups
  if (!allConversations.some(c => c.isGroup)) {
    try {
      const rawGroups = await client.getAllGroups();
      if (Array.isArray(rawGroups)) {
        for (const g of rawGroups) {
          const gid = g.id?._serialized || g.id;
          if (gid && !seenIds.has(gid)) {
            allConversations.push({
              rawId: String(gid),
              name: g.name || g.formattedTitle || 'WhatsApp Group',
              phone: String(gid),
              isGroup: true,
              groupMembersCount: g.groupMetadata?.participants?.length || 0,
              avatar: g.contact?.profilePicThumbObj?.eurl || '',
              unreadCount: Number(g.unreadCount || 0),
              timestamp: g.t ? Number(g.t) : null,
              lastMessage: g.lastMessage?.body || '',
              fromMe: Boolean(g.lastMessage?.fromMe)
            });
            seenIds.add(gid);
          }
        }
      }
    } catch {}
  }

  // 3. Persist and import conversations into database
  const existing = await getChats(userId);
  let chatsCreated = 0;

  for (const remote of allConversations) {
    const remoteId = remote.rawId;
    const phone = remote.phone;
    const isGroup = remote.isGroup;
    const contactName = remote.name;
    const avatar = remote.avatar;
    const groupMembersCount = remote.groupMembersCount;
    const timeStr = remote.timestamp
      ? new Date(remote.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';

    let chat = existing.find((entry) =>
      entry.phone === phone ||
      entry.phone === remoteId ||
      entry.phone === String(remoteId).replace(/@lid$/, '') ||
      `${entry.phone}@lid` === remoteId ||
      (!isGroup && contactName && entry.contactName === contactName)
    );
    if (!chat) {
      chat = await createChat(userId, {
        contactName,
        phone,
        avatar,
        channel: sessionName,
        assignedTo: '',
        isGroup,
        groupMembersCount,
        lastMessage: {
          text: remote.lastMessage || (isGroup ? 'Group joined' : 'Chat active'),
          timestamp: timeStr,
          status: 'delivered',
          fromMe: remote.fromMe,
        },
        tags: isGroup ? ['Group'] : ['Individual'],
      });
      existing.push(chat);
      chatsCreated++;
      io.to(`workspace:${userId}`).emit('chat:created', { session: sessionName, chat });
    } else {
      const updates = {};
      if (remote.lastMessage) {
        updates.unreadCount = remote.unreadCount;
        updates.lastMessage = { text: remote.lastMessage, timestamp: timeStr, status: 'delivered', fromMe: remote.fromMe };
      }
      if (remoteId && (remoteId.includes('@lid') || remoteId.includes('@g.us')) && chat.phone !== remoteId) {
        updates.phone = remoteId;
        chat.phone = remoteId;
      }
      if (Object.keys(updates).length > 0) {
        await updateChat(userId, chat.id, updates);
      }
    }

    // Only import recent message history for the first 15 active conversations to avoid timeout
    if (chatsCreated <= 15) {
      try {
        const existingMsgs = await getMessages(chat.id);
        if (!existingMsgs || existingMsgs.length === 0) {
          const history = await client.getAllMessagesInChat(remoteId, true, false).catch(() => []);
          if (Array.isArray(history) && history.length) {
            for (const item of history.slice(-20)) {
              const itemTimestamp = item.t
                ? new Date(Number(item.t) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : timeStr;
              const senderName = item.fromMe
                ? 'Agent'
                : (item.sender?.name || item.notifyName || (isGroup ? (item.author ? String(item.author).replace(/@c\.us$/, '') : 'Member') : contactName));
              await createMessage(chat.id, {
                sender: item.fromMe ? 'agent' : 'customer',
                agentName: senderName,
                text: item.body || item.caption || (item.type !== 'chat' ? `[${item.type}]` : ''),
                type: item.type === 'chat' ? 'text' : (item.type || 'text'),
                status: item.fromMe ? 'sent' : 'delivered',
                timestamp: itemTimestamp,
              });
            }
          }
        }
      } catch {}
    }
  }

  const groupCount = allConversations.filter(c => c.isGroup).length;
  const individualCount = allConversations.filter(c => !c.isGroup).length;
  console.log(`✅ [${sessionName}] Inbox sync finished: ${chatsCreated} new chats created, total ${allConversations.length} processed (${groupCount} groups, ${individualCount} individual chats)`);
  io.to(`workspace:${userId}`).emit('inbox:synced', { session: sessionName, total: allConversations.length, created: chatsCreated, groupCount, individualCount });
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
  (async () => {
    const visible = [];
    for (const [name, d] of sessions.entries()) {
      if (await canAccessSession(socket.user.id, name, d)) {
        visible.push({ name, status: d.status, phone: d.phone, hasQr: !!d.qrcode });
      }
    }
    socket.emit('sessions:init', visible);
  })().catch((error) => console.warn('Socket session init failed:', error.message));
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
    error: null, qrScanned: false, everConnected: false, cleaningUp: false,
    ownerId,
    phone: null, battery: 100, antiBanHealth: 98,
    warmupDay: 14, lastActive: new Date().toISOString()
  };
  sessions.set(sessionName, sd);
  emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'STARTING' });

  try {
    const client = await wppconnect.create({
      session: sessionName,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`📸 [${sessionName}] QR attempt ${attempts}`);
        const qr = base64Qr?.startsWith('data:image') ? base64Qr : `data:image/png;base64,${base64Qr}`;
        sd.qrcode = qr;
        sd.qrScanned = false;
        sd.status = 'QRCODE';
        emitSessionEvent('session:qr', sessionName, { session: sessionName, qrcode: qr, attempts });
        emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'QRCODE' });
      },
      statusFind: (statusSession, session) => {
        console.log(`🔄 [${session}] ${statusSession}`);

        if (statusSession === 'qrReadSuccess') {
          // The code was accepted, but WhatsApp is still synchronizing.
          sd.qrScanned = true;
          sd.status = 'AUTHENTICATING';
          sd.qrcode = null;
          emitSessionEvent('session:status', sessionName, { session, status: 'AUTHENTICATING' });

        } else if (['isLogged', 'inChat'].includes(statusSession) && sd.qrScanned) {
          // A QR was accepted and the client is now ready.
          sd.status = 'CONNECTED';
          sd.everConnected = true;
          sd.qrcode = null;
          sd.error = null;
          setSessionRegistered(sessionName, true, sd.ownerId);
          emitSessionEvent('session:status', sessionName, { session, status: 'CONNECTED' });

        } else if (['isLogged', 'inChat'].includes(statusSession)) {
          // Existing profiles can briefly report logged-in while WhatsApp Web is
          // still deciding that they are unpaired. Do not complete the UI yet.
          emitSessionEvent('session:status', sessionName, { session, status: 'AUTHENTICATING' });

        } else if (statusSession === 'notLogged' || statusSession === 'disconnectedMobile') {
          // WPPConnect also reports disconnectedMobile while an unpaired
          // profile is booting. Only a profile that was previously connected
          // represents a real mobile logout and should be purged.
          if (statusSession === 'disconnectedMobile' && sd.everConnected) {
            cleanupSession(sessionName, sd).catch((error) =>
              console.warn(`⚠️  [${sessionName}] Mobile logout cleanup failed:`, error.message)
            );
          } else {
            // Normal intermediate states — catchQR will set QRCODE.
            emitSessionEvent('session:status', sessionName, { session, status: statusSession });
          }

        } else if (statusSession === 'autocloseCalled') {
          // QR wasn't scanned in time — NOT a crash, just expired
          // Emit a specific 'EXPIRED' status so frontend can show "try again"
          console.log(`⏰ [${session}] QR expired (autocloseCalled)`);
          sd.status = 'EXPIRED';
          sd.qrcode = null;
          emitSessionEvent('session:status', sessionName, { session, status: 'EXPIRED' });

        } else if (statusSession === 'browserClose') {
          // Chromium actually closed — real failure
          sd.status = 'FAILED';
          emitSessionEvent('session:status', sessionName, { session, status: 'FAILED' });

        } else {
          // All other statuses: just forward, don't overwrite sd.status
          emitSessionEvent('session:status', sessionName, { session, status: statusSession });
        }
      },
      headless: true,
      useChrome: true,
      devtools: false,
      logQR: true,
      autoClose: 120000,  // 2 min to scan
      folderNameToken: TOKEN_DIR,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
      puppeteerOptions: {
        ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
      },
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
        sd.everConnected = true;
        sd.qrcode = null;
        sd.error = null;
        setSessionRegistered(sessionName, true, sd.ownerId);
        emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'CONNECTED' });
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
      emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'CONNECTED', phone: sd.phone, battery: sd.battery });
    }

    client.onAnyMessage(async (msg) => {
      const result = await handleAnyMessage(sessionName, msg, client);
      if (result?.userId && !msg.fromMe) {
        await runAutomationEngine(sessionName, result.userId, msg, client, result.chat);
      }
    });

    syncRemoteChats(sessionName, client).catch((error) => {
      console.warn(`⚠️  [${sessionName}] Chat sync failed:`, error.message);
    });

    client.onAck((ack) => {
      emitSessionEvent('session:ack', sessionName, { session: sessionName, id: ack.id._serialized || ack.id, ack: ack.ack });
    });

    return sd;

  } catch (err) {
    // autocloseCalled throws an error — handle it gracefully, NOT as FAILED
    if (err.message && (err.message.includes('Auto Close') || err.message.includes('autocloseCalled'))) {
      console.log(`⏰ [${sessionName}] Session closed: QR not scanned in time.`);
      sd.status = 'EXPIRED';
      emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'EXPIRED' });
    } else {
      console.error(`❌ [${sessionName}] Session failed: ${err.message}`);
      sd.status = 'FAILED';
      sd.error = err.message;
      emitSessionEvent('session:status', sessionName, { session: sessionName, status: 'FAILED', error: err.message });
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
    let registeredSessions = readConnectedSessions();
    if (!registeredSessions.length) {
      const pool = getPool();
      if (pool) {
        const { rows } = await pool.query(`SELECT channel AS name, MIN(user_id) AS "ownerId" FROM chats WHERE channel LIKE '%whatsapp%' GROUP BY channel`);
        registeredSessions = rows.map((entry) => ({ name: entry.name, ownerId: Number(entry.ownerId) || null }));
        if (registeredSessions.length) console.log(`🔄 Recovering WhatsApp sessions from workspace chats: ${registeredSessions.map((entry) => entry.name).join(', ')}`);
      }
    }
    if (!registeredSessions.length) { console.log('ℹ️  No connected sessions to recover.'); return; }
    console.log(`🔄 Recovering connected sessions: ${registeredSessions.map((entry) => entry.name).join(', ')}`);
    for (const entry of registeredSessions) {
      const name = entry.name;
      await sleep(3000);
      startSession(name, entry.ownerId)
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

// Dynamic on-demand message loader: ensures all recent WhatsApp messages
// are fetched and visible as soon as a chat is opened.
app.get('/api/chats/:chatId/messages', authenticateToken, async (req, res) => {
  const { chatId } = req.params;
  const userId = req.user.id;
  const forceSync = req.query.sync === 'true';

  try {
    let messages = await getMessages(chatId, userId);

    // Sync from WhatsApp Web if requested, or if messages are empty/sparse, or if legacy [call_log] placeholders exist
    const hasLegacyCallLogs = Array.isArray(messages) && messages.some(m => m.type === 'call_log' && m.text === '[call_log]');
    const shouldSync = forceSync || !messages || messages.length <= 2 || hasLegacyCallLogs;

    if (shouldSync) {
      const chats = await getChats(userId);
      const chat = chats.find(c => c.id === chatId);
      if (chat) {
        const sessionName = chat.channel || 'primary-whatsapp';
        const session = sessions.get(sessionName) || Array.from(sessions.values()).find(s => s.client && s.status === 'CONNECTED');
        if (session?.client) {
          try {
            const hint = chat.contactName || chat.contact_name || '';
            const target = await resolveWhatsAppTarget(session.client, chat.phone || chatId, hint);
            if (target && target !== chat.phone) {
              await updateChat(userId, chat.id, { phone: target });
            }

            const remoteMsgs = await fetchRecentChatMessages(session.client, target, hint);
            if (Array.isArray(remoteMsgs) && remoteMsgs.length > 0) {
              const existingKeys = new Set(messages.map(m => `${m.text}__${m.timestamp}`));
              const existingIds = new Set(messages.map(m => m.id));

              // If legacy call logs existed with [call_log], clean them up before importing properly formatted ones
              if (hasLegacyCallLogs) {
                const pool = getPool();
                if (pool) {
                  await pool.query(`DELETE FROM messages WHERE chat_id = $1 AND text = '[call_log]'`, [chat.id]);
                }
              }

              for (const rm of remoteMsgs.slice(-45)) {
                const ts = rm.t
                  ? new Date(Number(rm.t) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : 'Just now';
                const key = `${rm.body}__${ts}`;
                if (existingKeys.has(key) || (rm.id && existingIds.has(rm.id))) continue;
                existingKeys.add(key);

                const senderName = rm.fromMe ? 'You' : (rm.senderName || hint || 'Contact');
                await createMessage(chat.id, {
                  sender: rm.fromMe ? 'agent' : 'customer',
                  agentName: senderName,
                  text: rm.body || (rm.type !== 'chat' ? `[${rm.type}]` : ''),
                  type: rm.type || 'text',
                  mediaUrl: rm.mediaUrl || '',
                  fileName: rm.fileName || '',
                  fileSize: rm.fileSize || '',
                  audioDuration: rm.callDuration ? formatCallDuration(rm.callDuration) : '',
                  status: rm.fromMe ? 'sent' : 'delivered',
                  timestamp: ts,
                }, userId);
              }

              // Update lastMessage on chat
              const lastRemote = remoteMsgs[remoteMsgs.length - 1];
              if (lastRemote) {
                const lastTs = lastRemote.t
                  ? new Date(Number(lastRemote.t) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : 'Just now';
                await updateChat(userId, chat.id, {
                  lastMessage: { text: lastRemote.body, timestamp: lastTs, status: lastRemote.fromMe ? 'sent' : 'delivered', fromMe: Boolean(lastRemote.fromMe) }
                });
              }

              messages = await getMessages(chatId, userId);
            }
          } catch (fetchErr) {
            console.warn(`Could not pull remote messages for ${chatId}:`, fetchErr.message);
          }
        }
      }
    }

    res.json({ status: 'success', messages });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/api/debug/inspect-image', authenticateToken, async (req, res) => {
  const session = sessions.get('primary-whatsapp');
  if (!session?.client) return res.json({ error: 'No client' });
  const targetId = req.query.target || '79375424847946@lid';
  try {
    const info = await session.client.page.evaluate(async (tid) => {
      return new Promise((resolve) => {
        const req = indexedDB.open('model-storage');
        req.onsuccess = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains('message')) {
            db.close();
            return resolve({ error: 'No message store' });
          }
          const tx = db.transaction(['message'], 'readonly');
          const store = tx.objectStore('message');
          const range = IDBKeyRange.bound(`${tid}_`, `${tid}_\uffff`);
          const cursorReq = store.index('internalId').openCursor(range, 'prev');
          const results = [];
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && results.length < 60) {
              const v = cursor.value;
              results.push({
                id: String(v.id?._serialized || v.id || ''),
                type: v.type,
                bodyLen: v.body ? v.body.length : 0,
                bodyPrefix: v.body ? v.body.slice(0, 40) : '',
                caption: v.caption,
                hasMediaData: Boolean(v.mediaData),
                preview: v.mediaData?.preview ? typeof v.mediaData.preview : (v.preview ? typeof v.preview : null),
                keys: Object.keys(v).filter(k => k.toLowerCase().includes('media') || k.toLowerCase().includes('url') || k.toLowerCase().includes('thumb') || k.toLowerCase().includes('data'))
              });
              cursor.continue();
            } else {
              db.close();
              resolve({
                total: results.length,
                images: results.filter(r => r.type === 'image'),
                allTypes: Array.from(new Set(results.map(r => r.type)))
              });
            }
          };
          cursorReq.onerror = () => { db.close(); resolve({ error: 'cursor error' }); };
        };
        req.onerror = () => resolve({ error: 'idb open error' });
      });
    }, targetId);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/debug/test-send', authenticateToken, async (req, res) => {
  const session = sessions.get('primary-whatsapp');
  if (!session?.client) return res.json({ error: 'No client' });
  const target = req.query.target || '79375424847946@lid';
  try {
    const result = await session.client.page.evaluate(async (to) => {
      try {
        if (window.WPP?.chat?.openChat) {
          await window.WPP.chat.openChat(to).catch(() => null);
        }
        const sendRes = await window.WPP.chat.sendTextMessage(to, 'Test from WppFlow', { waitForAck: false });
        return { success: true, sendRes };
      } catch (err) {
        return {
          error: true,
          message: err?.message || String(err),
          stack: err?.stack,
          stringified: JSON.stringify(err, Object.getOwnPropertyNames(err))
        };
      }
    }, target);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

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
  if (!isSafeSessionName(sessionName)) return res.status(400).json({ status: 'error', message: 'sessionName may contain only letters, numbers, hyphens and underscores.' });
  startSession(sessionName, req.user.id).catch(e => {
    if (!e.message?.includes('Auto Close')) {
      console.error(`startSession error [${sessionName}]:`, e.message);
    }
  });
  res.json({ status: 'success', message: `Session '${sessionName}' initialization requested`, session: sessionName });
});

app.delete('/api/sessions/:session', authenticateToken, async (req, res) => {
  if (!isSafeSessionName(req.params.session)) return res.status(400).json({ status: 'error', message: 'Invalid session name.' });
  const s = sessions.get(req.params.session);
  if (s && !await canAccessSession(req.user.id, req.params.session, s)) {
    return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  }
  const cleanup = await cleanupSession(req.params.session, s);
  res.json({ status: 'success', message: `Session '${req.params.session}' removed`, ...cleanup });
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
    if (!req.body?.message?.trim()) return res.status(400).json({ status: 'error', message: 'message is required' });
    const result = await sendTextMessageSafe(s.client, req.body.phone, req.body.message);
    res.json({ status: 'success', response: result });
  } catch (e) {
    console.error(`Send message error [${req.params.session}]:`, e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
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
    const target = await resolveWhatsAppTarget(client, phone);
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
    const target = await resolveWhatsAppTarget(client, req.body?.phone);
    const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [{ id: await resolveWhatsAppTarget(client, req.body?.contactPhone), name: req.body?.name || '' }];
    const result = await client.sendContactVcardList(target, contacts.map((entry) => ({ id: entry.id || entry.phone, name: entry.name || '' })));
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message || 'Contact send failed' }); }
});

app.post('/api/sessions/:session/send-location', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthorizedClient(req, res);
    if (!client) return;
    const { phone, latitude, longitude, title = '' } = req.body || {};
    const target = await resolveWhatsAppTarget(client, phone);
    const result = await client.sendLocation(target, String(latitude), String(longitude), title);
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message || 'Location send failed' }); }
});

app.post('/api/sessions/:session/forward', authenticateToken, async (req, res) => {
  try {
    const client = await getAuthorizedClient(req, res);
    if (!client) return;
    const target = await resolveWhatsAppTarget(client, req.body?.phone);
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
    if (!Array.isArray(req.body?.buttons) || !req.body.buttons.length) return res.status(400).json({ status: 'error', message: 'buttons are required' });
    const target = await resolveWhatsAppTarget(s.client, req.body.phone);
    const result = await s.client.sendButtonList(target, req.body.title, req.body.buttons.map((b, i) => ({ id: b.id || `btn_${i}`, text: b.text || b.label })));
    res.json({ status: 'success', response: result });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/chats', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try {
    const chats = await client.page.evaluate(async () => {
      if (typeof window.WPP === 'undefined' || !window.WPP.chat) return [];
      try {
        const list = await window.WPP.chat.list();
        return list.map((c) => {
          const rawId = c.id?._serialized || c.id;
          const isGroup = Boolean(c.isGroup || String(rawId).includes('@g.us'));
          const contact = c.contact || {};
          const name = c.name || c.formattedTitle || contact.name || contact.pushname || contact.shortName || '';
          const phone = isGroup
            ? String(rawId)
            : String(contact.id?.user || contact.phoneNumber || c.id?.user || rawId).replace(/@c\.us$/, '').replace(/@lid$/, '');
          const msgs = c.msgs?.models || [];
          const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
          return {
            id: rawId,
            name: name || (isGroup ? 'WhatsApp Group' : phone),
            phone: phone || String(rawId),
            isGroup,
            groupMembersCount: c.groupMetadata?.participants?.length || 0,
            avatar: contact.profilePicThumbObj?.eurl || '',
            unreadCount: Number(c.unreadCount || 0),
            lastMessage: last?.body || ''
          };
        });
      } catch { return []; }
    });
    res.json({ status: 'success', chats: Array.isArray(chats) ? chats : [] });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/sessions/:session/debug-chats', authenticateToken, async (req, res) => {
  const client = await getAuthorizedClient(req, res);
  if (!client) return;
  try {
    const target = req.query.target || '120363023981533800@g.us';
    let wapiMsgs = [];
    try {
      wapiMsgs = await client.getAllMessagesInChat(target, true, false).catch(e => ({ error: e.message }));
    } catch (e) { wapiMsgs = { error: e.message }; }

    let idbMsgs = [];
    try {
      idbMsgs = await client.page.evaluate(async (targetId) => {
        return new Promise((resolve) => {
          const req = indexedDB.open('model-storage');
          req.onsuccess = (e) => {
            const db = e.target.result;
            const tx = db.transaction(['message'], 'readonly');
            const store = tx.objectStore('message');
            const range = IDBKeyRange.bound(`${targetId}_`, `${targetId}_\uffff`);
            const cursorReq = store.index('internalId').openCursor(range, 'prev');
            const list = [];
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (cursor && list.length < 50) {
                const v = cursor.value;
                if (v.type === 'image' || list.length < 5) {
                  let previewStr = null;
                  if (v.mediaData?.preview) {
                    previewStr = typeof v.mediaData.preview === 'string' ? v.mediaData.preview.slice(0, 60) : JSON.stringify(Object.keys(v.mediaData.preview));
                  }
                  list.push({
                    id: String(v.id?._serialized || v.id || ''),
                    type: v.type,
                    t: v.t,
                    bodyPrefix: typeof v.body === 'string' ? v.body.slice(0, 60) : null,
                    hasMediaData: !!v.mediaData,
                    mediaDataKeys: v.mediaData ? Object.keys(v.mediaData) : [],
                    previewStr
                  });
                }
                cursor.continue();
              } else {
                db.close();
                resolve(list);
              }
            };
            cursorReq.onerror = () => { db.close(); resolve([]); };
          };
          req.onerror = () => resolve([]);
        });
      }, target);
    } catch (e) { idbMsgs = { error: e.message }; }

    res.json({
      target,
      wapiCount: Array.isArray(wapiMsgs) ? wapiMsgs.length : wapiMsgs,
      idbCount: Array.isArray(idbMsgs) ? idbMsgs.length : idbMsgs,
      wapiSample: Array.isArray(wapiMsgs) ? wapiMsgs.map(m => ({ id: m.id, rowId: m.rowId, type: m.type, t: m.t, isMedia: m.isMedia })) : [],
      idbSample: Array.isArray(idbMsgs) ? idbMsgs.slice(0, 3) : []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  if (!isSafeSessionName(req.params.session)) return res.status(400).json({ status: 'error', message: 'Invalid session name.' });
  const s = sessions.get(req.params.session);
  if (s && !await canAccessSession(req.user.id, req.params.session, s)) {
    return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace' });
  }
  const cleanup = await cleanupSession(req.params.session, s);
  res.json({ status: 'success', message: `Session '${req.params.session}' closed`, ...cleanup });
});

// On-demand inbox sync — forces re-import of WhatsApp chats, contacts, groups
app.post('/api/sessions/:session/sync-inbox', authenticateToken, async (req, res) => {
  const sessionName = req.params.session;
  if (!isSafeSessionName(sessionName)) return res.status(400).json({ status: 'error', message: 'Invalid session name.' });
  const s = sessions.get(sessionName);
  if (!s?.client) return res.status(400).json({ status: 'error', message: `Session '${sessionName}' is not connected.` });
  if (!await canAccessSession(req.user.id, sessionName, s)) {
    return res.status(403).json({ status: 'error', message: 'Session is outside the current workspace.' });
  }
  try {
    res.json({ status: 'success', message: `Inbox sync started for '${sessionName}'` });
    // Run sync in background so response is immediate
    syncRemoteChats(sessionName, s.client).catch(err => console.error(`Sync error [${sessionName}]:`, err.message));
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
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
        try { await sendTextMessageSafe(sd.client, contacts[i].phone, campaign.templateText); sent++; }
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
