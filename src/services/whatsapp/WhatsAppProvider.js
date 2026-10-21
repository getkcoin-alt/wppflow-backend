import wppconnect from "@wppconnect-team/wppconnect";
import path from "path";
import fs from "fs";
import { ENV } from "../../config/env.js";
import { ACK_STATUS, SESSION_STATUS } from "../../config/constants.js";

const MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "ptt",
  "document",
  "sticker",
  "gif",
]);
const MEDIA_LABELS = {
  image: "📷 Photo",
  video: "🎥 Video",
  gif: "🎥 GIF",
  audio: "🎵 Voice message",
  ptt: "🎵 Voice message",
  document: "📄 Document",
  sticker: "Sticker",
  location: "📍 Location",
  vcard: "👤 Contact",
  multi_vcard: "👤 Contacts",
  call_log: "📞 Voice call",
  revoked: "🚫 This message was deleted",
};

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
      if (
        [
          SESSION_STATUS.CONNECTED,
          SESSION_STATUS.STARTING,
          SESSION_STATUS.QRCODE,
          SESSION_STATUS.AUTHENTICATING,
        ].includes(existing.status)
      ) {
        return existing;
      }
    }

    const legacyTokenDir = path.join(ENV.TOKEN_DIR, sessionName);
    const sessionTokenDir = path.join(
      ENV.TOKEN_DIR,
      `tenant_${tenantId}_${sessionName}`,
    );
    if (!fs.existsSync(sessionTokenDir)) {
      const owners = JSON.parse(process.env.LEGACY_SESSION_OWNERS || "{}");
      if (owners[sessionName] === tenantId && fs.existsSync(legacyTokenDir)) {
        try {
          fs.cpSync(legacyTokenDir, sessionTokenDir, { recursive: true });
          console.log(
            `🔑 Preserved legacy session tokens from ${legacyTokenDir} to ${sessionTokenDir}`,
          );
        } catch (e) {
          throw new Error(
            "Legacy session copy failed; original credentials preserved",
          );
        }
      } else {
        fs.mkdirSync(sessionTokenDir, { recursive: true, mode: 0o700 });
      }
    }

    const sessionState = {
      tenantId,
      sessionName,
      status: SESSION_STATUS.STARTING,
      client: null,
      qrcode: null,
      phone: null,
      battery: null,
      antiBanHealth: null,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(key, sessionState);

    const notify = (fn, ...args) => {
      if (fn)
        Promise.resolve()
          .then(() => fn(...args))
          .catch((error) => console.error("Provider event:", error.message));
    };
    const client = await wppconnect.create({
      session: `tenant_${tenantId}_${sessionName}`,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        sessionState.status = SESSION_STATUS.QRCODE;
        sessionState.qrcode = base64Qr;
        notify(callbacks.onQr, base64Qr, attempts);
        notify(callbacks.onStatus, SESSION_STATUS.QRCODE);
      },
      statusFind: (statusSession, session) => {
        if (statusSession === "isLogged" || statusSession === "inChat") {
          sessionState.status = SESSION_STATUS.CONNECTED;
          sessionState.qrcode = null;
          notify(callbacks.onStatus, SESSION_STATUS.CONNECTED);
        } else if (statusSession === "qrReadSuccess") {
          sessionState.status = SESSION_STATUS.AUTHENTICATING;
          sessionState.qrcode = null;
          notify(callbacks.onStatus, SESSION_STATUS.AUTHENTICATING);
        } else if (statusSession === "autocloseCalled") {
          sessionState.status = SESSION_STATUS.EXPIRED;
          sessionState.qrcode = null;
          notify(callbacks.onStatus, SESSION_STATUS.EXPIRED);
        } else if (
          statusSession === "browserClose" ||
          statusSession === "serverClose"
        ) {
          sessionState.status = SESSION_STATUS.DISCONNECTED;
          notify(callbacks.onStatus, SESSION_STATUS.DISCONNECTED);
        }
      },
      autoClose: ENV.QR_TIMEOUT_MS,
      headless: true,
      useChrome: true,
      devtools: false,
      folderNameToken: sessionTokenDir,
      browserArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
      ],
    });

    if (this.sessions.get(key) !== sessionState) {
      await client.close();
      throw new Error("Session startup was cancelled");
    }
    sessionState.client = client;
    sessionState.phone = await client.getWid().catch(() => null);
    sessionState.status = SESSION_STATUS.CONNECTED;
    if (callbacks.onStatus) await callbacks.onStatus(SESSION_STATUS.CONNECTED);

    // Register incoming message handler
    if (client?.onAnyMessage && callbacks.onMessage) {
      client.onAnyMessage((msg) => {
        const normalized = this.normalizeMessage(msg);
        normalized.downloadMedia = () => client.decryptFile(msg);
        normalized.mimeType = msg.mimetype?.split(";")[0]?.trim();
        normalized.byteSize = msg.size;
        notify(callbacks.onMessage, normalized);
      });
    }

    // Register ACK event handler
    if (client?.onAck && callbacks.onAck) {
      client.onAck((ackData) => {
        notify(callbacks.onAck, this.normalizeAck(ackData));
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
      const error = new Error(`WhatsApp session '${sessionName}' is offline.`);
      error.code = "SESSION_OFFLINE";
      throw error;
    }

    const rawStr = String(to).trim();
    const digits = rawStr.replace(/\D/g, "");
    const cleanTarget = rawStr.includes("@") ? rawStr : `${digits}@c.us`;

    // Use the supported provider API once. Never fall back to a second send.
    let result, timer;
    try {
      result = await Promise.race([
        session.client.sendText(cleanTarget, text, {
          createChat: true,
          waitForAck: true,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Delivery confirmation timed out")),
            20000,
          );
        }),
      ]);
    } catch {
      const error = new Error(
        "WhatsApp delivery outcome is uncertain. Reconcile before retrying.",
      );
      error.code = "DELIVERY_UNCERTAIN";
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const providerMessageId =
      result?.id?._serialized || result?.id?.id || result?.id || null;
    if (!providerMessageId || result?.timedOut) {
      const error = new Error("WhatsApp did not confirm a message identifier.");
      error.code = "DELIVERY_UNCERTAIN";
      throw error;
    }
    return {
      providerMessageId,
      to: cleanTarget,
      text,
      ack: result?.ack ?? ACK_STATUS.PENDING,
      raw: result,
    };
  }

  async syncConversations(tenantId, sessionName) {
    const session = this.getSession(tenantId, sessionName);
    if (!session?.client) throw new Error("WhatsApp session is offline");

    try {
      const chats = await session.client.page.evaluate(async () => {
        if (!window.WPP?.chat?.list) return [];
        const rawList = await window.WPP.chat.list();
        return rawList.filter((c) => {
          // WhatsApp Status updates and channels are not conversations.
          const id = String(c.id?._serialized || c.id || "");
          return !/@(broadcast|newsletter)$/.test(id);
        }).map((c) => {
          const rawId = String(c.id?._serialized || c.id || "");
          const isGroup = Boolean(c.isGroup || rawId.includes("@g.us"));
          const contact = c.contact || {};
          const name = (
            contact.verifiedName ||
            c.formattedTitle ||
            c.name ||
            contact.name ||
            contact.pushname ||
            ""
          ).trim();

          let lastBody = "";
          let fromMe = false;
          if (c.previewMessage && !c.previewMessage.invis) {
            fromMe = Boolean(c.previewMessage.fromMe);
            const pType = c.previewMessage.type;
            if (pType === "call_log") lastBody = "📞 Voice call";
            else if (pType === "image")
              lastBody = c.previewMessage.caption
                ? `📷 ${c.previewMessage.caption}`
                : "📷 Photo";
            else if (pType === "video")
              lastBody = c.previewMessage.caption
                ? `🎥 ${c.previewMessage.caption}`
                : "🎥 Video";
            else if (pType === "audio" || pType === "ptt")
              lastBody = "🎵 Voice message";
            else if (pType === "document")
              lastBody = c.previewMessage.caption
                ? `📄 ${c.previewMessage.caption}`
                : "📄 Document";
            else {
              lastBody =
                c.previewMessage.body || c.previewMessage.caption || "";
            }
          }

          return {
            id: rawId,
            phone: rawId,
            contactName: name || (isGroup ? "WhatsApp Group" : rawId),
            avatar: contact.profilePicThumbObj?.eurl || "",
            isGroup,
            groupMembersCount: c.groupMetadata?.participants?.length || 0,
            unreadCount: Number(c.unreadCount || 0),
            lastActiveEpoch: Number(c.t || 0),
            lastMessage: {
              text: lastBody || (isGroup ? "Group joined" : "Chat active"),
              status: fromMe ? "sent" : "delivered",
              fromMe,
            },
          };
        });
      });

      return Array.isArray(chats) ? chats : [];
    } catch (err) {
      console.warn(`Conversation sync error for ${sessionName}:`, err.message);
      throw err;
    }
  }

  normalizeMessage(raw) {
    const id = String(raw.id?._serialized || raw.id?.id || raw.id || "");
    const fromMe = Boolean(raw.fromMe);
    const remoteId = fromMe
      ? String(
          raw.to || raw.chatId?._serialized || raw.chat?.id?._serialized || "",
        )
      : String(
          raw.from ||
            raw.chatId?._serialized ||
            raw.chat?.id?._serialized ||
            "",
        );
    const rawType = String(raw.type || "chat");
    const type =
      rawType === "chat"
        ? "text"
        : rawType === "ptt"
          ? "audio"
          : rawType;
    // For photos, videos, stickers, documents... WhatsApp puts a base64 thumbnail in `body`.
    // That is never message text: show the caption, or a label like WhatsApp's own preview.
    const looksLikeBlob = (s) =>
      typeof s === "string" && s.length > 120 && !/\s/.test(s);
    const label = MEDIA_LABELS[rawType] || "";
    const body = raw.body && !looksLikeBlob(raw.body) ? raw.body : "";
    const text =
      rawType === "chat"
        ? raw.body || ""
        : MEDIA_TYPES.has(rawType)
          ? raw.caption || label
          : body || raw.caption || label;
    const isGroup = Boolean(raw.isGroupMsg) || remoteId.endsWith("@g.us");
    // The group's own subject, never the name of whoever happened to post in it.
    const groupName = isGroup
      ? String(
          raw.chat?.formattedTitle ||
            raw.chat?.name ||
            raw.chat?.contact?.name ||
            "",
        ).trim()
      : "";
    const timestampEpoch =
      Number(raw.timestamp || raw.t) || Math.floor(Date.now() / 1000);

    return {
      providerMessageId: id,
      fromMe,
      ack: Number.isInteger(raw.ack) ? raw.ack : 0,
      remoteId,
      isGroup,
      groupName,
      rawType,
      senderName: fromMe
        ? "You"
        : raw.sender?.name ||
          raw.sender?.pushname ||
          raw.sender?.formattedName ||
          raw.notifyName ||
          "Customer",
      text,
      type,
      timestampEpoch,
      mediaUrl: "", // Never persist expiring provider URLs as durable media.
      fileName: raw.filename || "",
      fileSize: raw.size ? `${Math.round(raw.size / 1024)} KB` : "",
    };
  }

  async getContacts(tenantId, sessionName) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) throw new Error("WhatsApp session is offline");
    return client.getAllContacts();
  }
  async sendAttachment(tenantId, sessionName, to, attachmentId, type, caption) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) {
      const e = new Error("WhatsApp session is offline");
      e.code = "SESSION_OFFLINE";
      throw e;
    }
    const { query } = await import("../../db/index.js");
    const { readMedia } = await import("../mediaService.js");
    const { rows } = await query(
      "SELECT * FROM attachments WHERE id=$1 AND tenant_id=$2 AND upload_status='ready'",
      [attachmentId, tenantId],
    );
    if (!rows[0]) throw new Error("Attachment is unavailable");
    const a = rows[0],
      buffer = await readMedia(a.storage_key);
    let result;
    try {
      result = await client.sendFile(
        to,
        `data:${a.mime_type};base64,${buffer.toString("base64")}`,
        { filename: a.original_name, caption },
      );
    } catch {
      const e = new Error("Attachment delivery is uncertain");
      e.code = "DELIVERY_UNCERTAIN";
      throw e;
    }
    const id = result?.id?._serialized || result?.id?.id || result?.id;
    if (!id) {
      const e = new Error("Attachment delivery is uncertain");
      e.code = "DELIVERY_UNCERTAIN";
      throw e;
    }
    return { providerMessageId: id, ack: result.ack ?? 0 };
  }
  async getHistory(tenantId, sessionName, chatId, count = 100) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) throw new Error("WhatsApp session is offline");
    return (await client.getMessages(chatId, { count })).map((raw) =>
      this.normalizeMessage(raw),
    );
  }
  async markRead(tenantId, sessionName, chatId) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) throw new Error("WhatsApp session is offline");
    await client.sendSeen(chatId);
  }

  normalizeAck(raw) {
    const id = String(raw.id?._serialized || raw.id?.id || raw.id || "");
    const ackNumber = Number(raw.ack || 0);
    let mappedAck = ackNumber === 0 ? ACK_STATUS.PENDING : ACK_STATUS.SERVER;

    if (ackNumber === 2) mappedAck = ACK_STATUS.DELIVERY;
    else if (ackNumber >= 3) mappedAck = ACK_STATUS.READ;
    else if (ackNumber < 0) mappedAck = ACK_STATUS.ERROR;

    return {
      providerMessageId: id,
      ack: mappedAck,
      rawAck: ackNumber,
    };
  }
}

export const defaultWhatsAppProvider = new WhatsAppProvider();
