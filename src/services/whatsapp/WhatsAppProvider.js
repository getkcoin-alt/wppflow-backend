import wppconnect from '@wppconnect-team/wppconnect';
import path from 'path';
import fs from 'fs';
import { ENV } from '../../config/env.js';
import { ACK_STATUS, SESSION_STATUS } from '../../config/constants.js';

export class WhatsAppProvider {
  constructor() {
    this.sessions = new Map(); // key: `${tenantId}:${sessionName}`, value: SessionRecord
  }

  sessionKey(tenantId, sessionName) {
    return `${tenantId}:::${sessionName}`;
  }

  hasSession(tenantId, sessionName) {
    return this.sessions.has(this.sessionKey(tenantId, sessionName));
  }

  getSession(tenantId, sessionName) {
    return this.sessions.get(this.sessionKey(tenantId, sessionName));
  }

  async startSession(tenantId, sessionName, callbacks = {}) {
    const key = this.sessionKey(tenantId, sessionName);
    if (this.sessions.has(key)) {
      const existing = this.sessions.get(key);
      if (existing.status === SESSION_STATUS.CONNECTED) {
        return existing;
      }
    }

    const sessionTokenDir = path.join(ENV.TOKEN_DIR, `tenant_${tenantId}_${sessionName}`);
    if (!fs.existsSync(sessionTokenDir)) {
      fs.mkdirSync(sessionTokenDir, { recursive: true });
    }

    const sessionState = {
      tenantId,
      sessionName,
      status: SESSION_STATUS.STARTING,
      client: null,
      qrcode: null,
      phone: null,
      battery: 100,
      antiBanHealth: 100,
      createdAt: new Date().toISOString()
    };
    this.sessions.set(key, sessionState);

    const client = await wppconnect.create({
      session: `tenant_${tenantId}_${sessionName}`,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        sessionState.status = SESSION_STATUS.QRCODE;
        sessionState.qrcode = base64Qr;
        if (callbacks.onQr) callbacks.onQr(base64Qr, attempts);
        if (callbacks.onStatus) callbacks.onStatus(SESSION_STATUS.QRCODE);
      },
      statusFind: (statusSession, session) => {
        if (statusSession === 'isLogged' || statusSession === 'inChat') {
          sessionState.status = SESSION_STATUS.CONNECTED;
          sessionState.qrcode = null;
          if (callbacks.onStatus) callbacks.onStatus(SESSION_STATUS.CONNECTED);
        } else if (statusSession === 'qrReadSuccess') {
          sessionState.status = SESSION_STATUS.AUTHENTICATING;
          sessionState.qrcode = null;
          if (callbacks.onStatus) callbacks.onStatus(SESSION_STATUS.AUTHENTICATING);
        } else if (statusSession === 'autocloseCalled') {
          sessionState.status = SESSION_STATUS.EXPIRED;
          sessionState.qrcode = null;
          if (callbacks.onStatus) callbacks.onStatus(SESSION_STATUS.EXPIRED);
        } else if (statusSession === 'browserClose' || statusSession === 'serverClose') {
          sessionState.status = SESSION_STATUS.DISCONNECTED;
          if (callbacks.onStatus) callbacks.onStatus(SESSION_STATUS.DISCONNECTED);
        }
      },
      headless: true,
      useChrome: true,
      devtools: false,
      folderNameToken: sessionTokenDir,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
      ]
    });

    sessionState.client = client;

    // Register incoming message handler
    if (client?.onAnyMessage && callbacks.onMessage) {
      client.onAnyMessage((msg) => {
        callbacks.onMessage(this.normalizeMessage(msg));
      });
    }

    // Register ACK event handler
    if (client?.onAck && callbacks.onAck) {
      client.onAck((ackData) => {
        callbacks.onAck(this.normalizeAck(ackData));
      });
    }

    return sessionState;
  }

  async closeSession(tenantId, sessionName) {
    const key = this.sessionKey(tenantId, sessionName);
    const session = this.sessions.get(key);
    if (session?.client) {
      try {
        await session.client.close();
      } catch (err) {
        console.warn(`Error closing session ${sessionName}:`, err.message);
      }
    }
    this.sessions.delete(key);
  }

  async sendTextMessage(tenantId, sessionName, to, text) {
    const key = this.sessionKey(tenantId, sessionName);
    const session = this.sessions.get(key);
    if (!session?.client) {
      throw new Error(`WhatsApp session '${sessionName}' not connected for this workspace.`);
    }

    const cleanTarget = String(to).includes('@') ? to : `${String(to).replace(/\D/g, '')}@c.us`;

    // Send through WPPConnect
    let result = null;
    try {
      result = await session.client.sendText(cleanTarget, text);
    } catch (err) {
      // Fallback via page evaluate if sendText fails on specific LID/Wid variations
      result = await session.client.page.evaluate(async (target, msg) => {
        if (!window.WPP?.chat?.sendTextMessage) throw new Error('WA-JS chat engine not ready');
        return await window.WPP.chat.sendTextMessage(target, msg, { createChat: true });
      }, cleanTarget, text);
    }

    const providerMessageId = result?.id?._serialized || result?.id?.id || result?.id || null;
    return {
      providerMessageId,
      to: cleanTarget,
      text,
      ack: ACK_STATUS.SERVER,
      raw: result
    };
  }

  async syncConversations(tenantId, sessionName) {
    const session = this.getSession(tenantId, sessionName);
    if (!session?.client) return [];

    try {
      const chats = await session.client.page.evaluate(async () => {
        if (!window.WPP?.chat?.list) return [];
        const rawList = await window.WPP.chat.list();
        return rawList.map((c) => {
          const rawId = String(c.id?._serialized || c.id || '');
          const isGroup = Boolean(c.isGroup || rawId.includes('@g.us'));
          const contact = c.contact || {};
          const name = (contact.verifiedName || c.formattedTitle || c.name || contact.name || contact.pushname || '').trim();
          
          let lastBody = '';
          let fromMe = false;
          if (c.previewMessage && !c.previewMessage.invis) {
            fromMe = Boolean(c.previewMessage.fromMe);
            const pType = c.previewMessage.type;
            if (pType === 'call_log') lastBody = '📞 Voice call';
            else if (pType === 'image') lastBody = c.previewMessage.caption ? `📷 ${c.previewMessage.caption}` : '📷 Photo';
            else if (pType === 'video') lastBody = c.previewMessage.caption ? `🎥 ${c.previewMessage.caption}` : '🎥 Video';
            else if (pType === 'audio' || pType === 'ptt') lastBody = '🎵 Voice message';
            else if (pType === 'document') lastBody = c.previewMessage.caption ? `📄 ${c.previewMessage.caption}` : '📄 Document';
            else {
              lastBody = c.previewMessage.body || c.previewMessage.caption || '';
            }
          }

          return {
            id: rawId,
            phone: rawId,
            contactName: name || (isGroup ? 'WhatsApp Group' : rawId),
            avatar: contact.profilePicThumbObj?.eurl || '',
            isGroup,
            groupMembersCount: c.groupMetadata?.participants?.length || 0,
            unreadCount: Number(c.unreadCount || 0),
            lastActiveEpoch: Number(c.t || 0),
            lastMessage: {
              text: lastBody || (isGroup ? 'Group joined' : 'Chat active'),
              status: fromMe ? 'sent' : 'delivered',
              fromMe
            }
          };
        });
      });

      return Array.isArray(chats) ? chats : [];
    } catch (err) {
      console.warn(`Conversation sync error for ${sessionName}:`, err.message);
      return [];
    }
  }

  normalizeMessage(raw) {
    const id = String(raw.id?._serialized || raw.id?.id || raw.id || '');
    const fromMe = Boolean(raw.fromMe);
    const remoteId = String(raw.from || raw.to || raw.chatId?._serialized || '');
    const text = raw.body || raw.caption || '';
    const type = raw.type === 'chat' ? 'text' : (raw.type || 'text');
    const timestampEpoch = raw.t ? Number(raw.t) : Math.floor(Date.now() / 1000);

    return {
      providerMessageId: id,
      fromMe,
      remoteId,
      senderName: raw.sender?.name || raw.notifyName || (fromMe ? 'You' : 'Customer'),
      text,
      type,
      timestampEpoch,
      mediaUrl: raw.mediaUrl || '',
      fileName: raw.filename || '',
      fileSize: raw.size ? `${Math.round(raw.size / 1024)} KB` : ''
    };
  }

  normalizeAck(raw) {
    const id = String(raw.id?._serialized || raw.id?.id || raw.id || '');
    const ackNumber = Number(raw.ack || 0);
    let mappedAck = ACK_STATUS.SERVER;

    if (ackNumber === 2) mappedAck = ACK_STATUS.DELIVERY;
    else if (ackNumber >= 3) mappedAck = ACK_STATUS.READ;
    else if (ackNumber < 0) mappedAck = ACK_STATUS.ERROR;

    return {
      providerMessageId: id,
      ack: mappedAck,
      rawAck: ackNumber
    };
  }
}

export const defaultWhatsAppProvider = new WhatsAppProvider();
