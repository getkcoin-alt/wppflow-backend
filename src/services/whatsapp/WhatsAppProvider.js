import wppconnect from "@wppconnect-team/wppconnect";
import path from "path";
import fs from "fs";
import { ENV } from "../../config/env.js";
import { ACK_STATUS, SESSION_STATUS } from "../../config/constants.js";
import { stopBrowsers, clearProfileLocks } from "./browserProcess.js";

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
    const sessionTokenDir = this.tokenDir(tenantId, sessionName);
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
    const profileDir = this.profileDir(tenantId, sessionName);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    const createOptions = {
      session: `tenant_${tenantId}_${sessionName}`,
      catchQR: (base64Qr, asciiQR, attempts, urlCode) => {
        console.log(`WhatsApp ${sessionName}: QR code ready (attempt ${attempts})`);
        sessionState.status = SESSION_STATUS.QRCODE;
        sessionState.qrcode = base64Qr;
        notify(callbacks.onQr, base64Qr, attempts);
        notify(callbacks.onStatus, SESSION_STATUS.QRCODE);
      },
      statusFind: (statusSession, session) => {
        // One line per step, so a number that "connects by itself" can be told from one that was scanned.
        console.log(`WhatsApp ${sessionName}: ${statusSession}`);
        if (statusSession === "isLogged" || statusSession === "inChat") {
          // While the login is still being checked these can arrive for a number that has not been
          // scanned yet (a fresh or unpaired profile reported inChat, then notLogged and a QR code).
          // The number is connected when create() returns, below; only later reports count here.
          if (!sessionState.client) return;
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
      // WPPConnect keeps a single shared `puppeteerOptions` object in its defaults and writes the
      // first session's profile folder into it, so every later session in this process would reuse
      // that folder ("The browser is already running for ..."). Give each session its own.
      puppeteerOptions: { userDataDir: path.resolve(profileDir) },
      browserArgs: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-gpu",
      ],
    };
    // A browser left over from an earlier attempt (a pairing cancelled while its QR code was showing,
    // a restarted worker) would keep this profile locked. Nothing in this process owns the profile at
    // this point, so whatever is using it is stale.
    await this.releaseProfile(tenantId, sessionName);
    const cancelled = () => {
      const error = new Error("Session startup was cancelled");
      error.code = "SESSION_CANCELLED";
      return error;
    };
    let client;
    try {
      try {
        client = await wppconnect.create(createOptions);
      } catch (error) {
        if (!/already running/i.test(String(error?.message))) throw error;
        await this.releaseProfile(tenantId, sessionName);
        client = await wppconnect.create(createOptions);
      }
    } catch (error) {
      // Cancelled or replaced while starting (the pairing was closed, the number removed): whoever did
      // that already cleaned up, and a newer attempt may own this key now.
      if (this.sessions.get(key) !== sessionState) throw cancelled();
      throw error;
    }

    if (this.sessions.get(key) !== sessionState) {
      await client.close();
      throw cancelled();
    }
    sessionState.client = client;
    sessionState.phone = await client.getWid().catch(() => null);
    console.log(`WhatsApp ${sessionName}: signed in as …${String(sessionState.phone || "").replace(/\D/g, "").slice(-4) || "unknown"}`);
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

  tokenDir(tenantId, sessionName) {
    return path.join(ENV.TOKEN_DIR, `tenant_${tenantId}_${sessionName}`);
  }

  // The Chromium profile folder WPPConnect uses for this session: <token folder>/<session id>.
  profileDir(tenantId, sessionName) {
    return path.join(
      this.tokenDir(tenantId, sessionName),
      `tenant_${tenantId}_${sessionName}`,
    );
  }

  // Stops any browser still holding this session's profile and clears its lock files.
  async releaseProfile(tenantId, sessionName) {
    const dir = this.profileDir(tenantId, sessionName);
    try {
      const stopped = await stopBrowsers(dir);
      if (stopped)
        console.warn(
          `Stopped ${stopped} leftover browser process(es) for ${sessionName}`,
        );
      clearProfileLocks(dir);
    } catch (error) {
      console.warn(`Could not release browser profile for ${sessionName}: ${error.message}`);
    }
  }

  // Unlinks this computer from the person's phone (WhatsApp -> Linked devices) and discards
  // the saved login. Closing the browser alone leaves the device linked. Returns whether
  // WhatsApp confirmed the unlink; false means it must be removed from the phone by hand.
  async logoutSession(tenantId, sessionName) {
    const session = this.getSession(tenantId, sessionName);
    if (!session?.client) return false;
    let timer;
    try {
      const result = await Promise.race([
        session.client.logout(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("logout timed out")), 15000);
        }),
      ]);
      return result !== false;
    } catch (error) {
      console.warn(`WhatsApp logout for ${sessionName} failed: ${error.message}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Removes the saved login and browser profile from disk. Never touches anything outside
  // the token directory.
  deleteTokens(tenantId, sessionName) {
    const base = path.resolve(ENV.TOKEN_DIR);
    const target = path.resolve(this.tokenDir(tenantId, sessionName));
    if (!target.startsWith(base + path.sep)) return false;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return true;
    } catch (error) {
      console.warn(`Could not delete saved login for ${sessionName}: ${error.message}`);
      return false;
    }
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
    // While a number is still pairing (QR code on screen) there is no client to close, but the
    // browser is running. Stop it so it cannot linger and lock the profile.
    await this.releaseProfile(tenantId, sessionName);
  }

  async sendTextMessage(tenantId, sessionName, to, text, options = {}) {
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
      const sendOpts = {
        createChat: true,
        waitForAck: true,
        ...(options?.quotedMsg ? { quotedMsg: options.quotedMsg } : {}),
      };
      result = await Promise.race([
        session.client.sendText(cleanTarget, text, sendOpts),
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

  async deleteMessage(
    tenantId,
    sessionName,
    chatId,
    providerMessageId,
    onlyLocal = false,
  ) {
    const session = this.getSession(tenantId, sessionName);
    if (!session?.client) throw new Error("WhatsApp session is offline");
    const rawStr = String(chatId).trim();
    const cleanTarget = rawStr.includes("@")
      ? rawStr
      : `${rawStr.replace(/\D/g, "")}@c.us`;
    return await session.client.deleteMessage(
      cleanTarget,
      providerMessageId,
      Boolean(onlyLocal),
      true,
    );
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

    let quoted = null;
    const q = raw.quotedMsg || raw.quotedMsgObj;
    if (q) {
      const qFromMe = Boolean(q.fromMe);
      const qRawType = String(q.type || "chat");
      const qType =
        qRawType === "chat" ? "text" : qRawType === "ptt" ? "audio" : qRawType;
      const qLabel = MEDIA_LABELS[qRawType] || "";
      const qText =
        qRawType === "chat"
          ? q.body || ""
          : q.caption || qLabel || q.body || "";
      const qId = String(q.id?._serialized || q.id?.id || q.id || "");
      if (qId || qText) {
        quoted = {
          id: qId,
          providerMessageId: qId,
          sender: qFromMe ? "agent" : "customer",
          agentName: qFromMe
            ? "You"
            : q.sender?.name || q.sender?.pushname || "Customer",
          text: qText,
          type: qType,
        };
      }
    }

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
      quoted,
    };
  }

  // Is this number on WhatsApp? `checked: false` means it could not be found out (the number is offline or the
  // lookup failed), which is not the same as "no": the caller decides whether to go ahead.
  // "Are you there?": asks the linked phone's WhatsApp Web whether it is still connected. A browser that has hung
  // or a phone that lost its link answers late or not at all, which is what the number-health check looks for.
  async ping(tenantId, sessionName, timeoutMs = 8000) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) return { ok: false, error: "This number is not running on the server" };
    if (typeof client.isConnected !== "function") return { ok: true };
    let timer;
    try {
      const connected = await Promise.race([
        client.isConnected(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(timeoutMs / 1000)} second${Math.round(timeoutMs / 1000) === 1 ? "" : "s"}`)), timeoutMs);
        }),
      ]);
      return connected ? { ok: true } : { ok: false, error: "WhatsApp reports this number as not connected" };
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  async checkNumber(tenantId, sessionName, phone) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client || typeof client.checkNumberStatus !== "function") return { checked: false };
    let timer;
    try {
      const result = await Promise.race([
        client.checkNumberStatus(`${String(phone).replace(/\D/g, "")}@c.us`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), 8000);
        }),
      ]);
      if (result?.numberExists === false) return { checked: true, exists: false };
      return { checked: true, exists: true, jid: result?.id?._serialized || null };
    } catch {
      return { checked: false };
    } finally {
      clearTimeout(timer);
    }
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
  // Downloads one message's file from WhatsApp, for messages that were never saved. Works only while
  // WhatsApp still holds the file; errors carry a code so the caller can explain what happened.
  async fetchMedia(tenantId, sessionName, providerMessageId, chatId) {
    const client = this.getSession(tenantId, sessionName)?.client;
    const coded = (message, code, extra = {}) =>
      Object.assign(new Error(message), { code, ...extra });
    if (!client) throw coded("WhatsApp session is offline", "SESSION_OFFLINE");
    const { limitFor } = await import("../mediaService.js");
    const hasFile = (m) => m && (m.mediaKey || m.clientUrl || m.deprecatedMms3Url);
    const idOf = (m) => String(m?.id?._serialized || m?.id?.id || m?.id || "");
    let raw = await client.getMessageById(providerMessageId).catch(() => null);
    if (!hasFile(raw)) {
      // Older messages are not always loaded into WhatsApp Web yet: load the chat's recent history and look again.
      const recent = await client.getMessages(chatId, { count: 200 }).catch(() => []);
      raw = recent.find((m) => idOf(m) === providerMessageId) || raw;
    }
    if (!hasFile(raw))
      throw coded("WhatsApp no longer has this message's file", "MEDIA_UNAVAILABLE");
    const mime = String(raw.mimetype || "").split(";")[0].trim().toLowerCase();
    const claimed = Number(raw.size) || 0;
    if (mime && claimed && claimed > limitFor(mime))
      throw coded("File too large", "MEDIA_TOO_LARGE", { limit: limitFor(mime), size: claimed });
    let buffer;
    try {
      buffer = await client.decryptFile(raw);
    } catch {
      try {
        // WhatsApp Web's own downloader, which copes with links that have since rotated.
        const data = await client.downloadMedia(raw);
        buffer = Buffer.from(String(data).split(",").pop(), "base64");
      } catch {
        throw coded("The file could not be downloaded", "MEDIA_UNAVAILABLE");
      }
    }
    if (!buffer?.length) throw coded("The file was empty", "MEDIA_UNAVAILABLE");
    return { buffer, mime, fileName: raw.filename || "", size: buffer.length };
  }

  async getHistory(tenantId, sessionName, chatId, count = 100) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) throw new Error("WhatsApp session is offline");
    // Everything returned here belongs to the chat that was asked for, whatever shape WhatsApp gives
    // the sender and recipient ids (phone numbers or privacy "lid" ids). Trusting those fields could
    // file the messages under a different conversation and leave this one empty.
    return (await client.getMessages(chatId, { count })).map((raw) => {
      const msg = this.normalizeMessage(raw);
      return {
        ...msg,
        remoteId: chatId,
        isGroup: msg.isGroup || chatId.endsWith("@g.us"),
      };
    });
  }
  // The current picture of a chat or a contact, asked of WhatsApp itself. The `profilePicThumbObj` that comes with a contact
  // is deprecated by the library and, on current WhatsApp Web, is usually empty; this is the lookup it recommends instead.
  // An empty string means the person has no picture, or hides it from us. The address is signed and runs out, so it is
  // only ever used straight away to fetch the image, never stored as the picture.
  async getProfilePicUrl(tenantId, sessionName, chatId) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) throw new Error("WhatsApp session is offline");
    const pic = await client.getProfilePicFromServer(chatId);
    return [pic?.eurl, pic?.img, pic?.imgFull].find((u) => typeof u === "string" && u.startsWith("https://")) || "";
  }
  // WhatsApp hides some people's numbers behind a "…@lid" id. When the phone has learned the real number, this returns its
  // digits; otherwise "".
  async resolveLidPhone(tenantId, sessionName, lidId) {
    const client = this.getSession(tenantId, sessionName)?.client;
    if (!client) throw new Error("WhatsApp session is offline");
    const found = await client.page.evaluate(async (id) => {
      if (!window.WPP?.contact?.getPnLidEntry) return "";
      const entry = await window.WPP.contact.getPnLidEntry(id);
      return String(entry?.phoneNumber?._serialized || entry?.phoneNumber?.id || "");
    }, lidId);
    return String(found).replace(/(?::\d+)?@c\.us$/, "").replace(/\D/g, "");
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
