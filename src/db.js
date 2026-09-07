import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
let isPgConnected = false;

// In-memory fallback stores
const memoryUsers = new Map();
const memoryContacts = new Map();
const memoryChats = new Map();
const memoryMessages = new Map(); // key: chatId, value: []
const memoryCampaigns = new Map();
const memoryAutomations = new Map();

export async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

export async function initDatabase() {
  console.log('🔄 Initializing Database Layer...');

  if (DATABASE_URL) {
    try {
      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('sslmode=require')
          ? false
          : undefined,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
      });

      const client = await pool.connect();
      console.log('✅ Connected to PostgreSQL database successfully!');
      isPgConnected = true;

      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          company_name VARCHAR(255) DEFAULT 'WppFlow Workspace',
          role VARCHAR(50) DEFAULT 'user',
          plan VARCHAR(50) DEFAULT 'Growth',
          sessions_limit INT DEFAULT 5,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS contacts (
          id VARCHAR(64) PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          phone VARCHAR(64) NOT NULL,
          email VARCHAR(255) DEFAULT '',
          avatar VARCHAR(512) DEFAULT '',
          tags JSONB DEFAULT '[]',
          custom_traits JSONB DEFAULT '{}',
          lifetime_value NUMERIC DEFAULT 0,
          channel VARCHAR(100) DEFAULT 'general',
          last_seen VARCHAR(100) DEFAULT 'Unknown',
          assigned_agent VARCHAR(255) DEFAULT '',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS chats (
          id VARCHAR(64) PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          contact_id VARCHAR(64),
          contact_name VARCHAR(255) NOT NULL,
          phone VARCHAR(64) NOT NULL,
          avatar VARCHAR(512) DEFAULT '',
          unread_count INT DEFAULT 0,
          is_group BOOLEAN DEFAULT false,
          group_members_count INT DEFAULT 0,
          channel VARCHAR(50) DEFAULT 'sales',
          assigned_to VARCHAR(255) DEFAULT '',
          is_closed BOOLEAN DEFAULT false,
          last_message JSONB DEFAULT '{}',
          tags JSONB DEFAULT '[]',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(64) PRIMARY KEY,
          chat_id VARCHAR(64) REFERENCES chats(id) ON DELETE CASCADE,
          sender VARCHAR(50) NOT NULL,
          agent_name VARCHAR(255) DEFAULT '',
          text TEXT DEFAULT '',
          type VARCHAR(50) DEFAULT 'text',
          media_url VARCHAR(512) DEFAULT '',
          file_name VARCHAR(255) DEFAULT '',
          file_size VARCHAR(50) DEFAULT '',
          audio_duration VARCHAR(20) DEFAULT '',
          buttons JSONB DEFAULT '[]',
          is_note BOOLEAN DEFAULT false,
          status VARCHAR(50) DEFAULT 'sent',
          timestamp VARCHAR(50) DEFAULT '',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS campaigns (
          id VARCHAR(64) PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          target_segment VARCHAR(255) DEFAULT '',
          total_recipients INT DEFAULT 0,
          sent_count INT DEFAULT 0,
          delivered_count INT DEFAULT 0,
          read_count INT DEFAULT 0,
          replied_count INT DEFAULT 0,
          failed_count INT DEFAULT 0,
          cost_saved_meta NUMERIC DEFAULT 0,
          status VARCHAR(50) DEFAULT 'draft',
          template_text TEXT DEFAULT '',
          anti_ban_delay_seconds INT DEFAULT 4,
          scheduled_for VARCHAR(100) DEFAULT '',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS automations (
          id VARCHAR(64) PRIMARY KEY,
          user_id INT REFERENCES users(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          trigger_type VARCHAR(100) DEFAULT 'keyword',
          trigger_condition TEXT DEFAULT '',
          action_type VARCHAR(100) DEFAULT 'reply_text',
          action_summary TEXT DEFAULT '',
          is_enabled BOOLEAN DEFAULT true,
          executions_count INT DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(`ALTER TABLE messages ALTER COLUMN media_url TYPE TEXT`);

      console.log('✅ PostgreSQL Schema verified: all tables ready.');
      client.release();
    } catch (err) {
      console.warn(`⚠️ PostgreSQL connection failed (${err.message}). Using in-memory store.`);
      isPgConnected = false;
    }
  } else {
    console.log('ℹ️ No DATABASE_URL. Using memory store.');
  }

  await seedDefaultUsers();
}

async function seedDefaultUsers() {
  const adminHash = await hashPassword('admin123');
  const demoHash = await hashPassword('demo123');

  if (isPgConnected && pool) {
    try {
      const { rows } = await pool.query('SELECT COUNT(*) FROM users');
      if (parseInt(rows[0].count, 10) === 0) {
        await pool.query(`
          INSERT INTO users (email, password_hash, name, company_name, role, plan, sessions_limit)
          VALUES
            ('admin@wppflow.io', $1, 'Super Admin', 'WppFlow HQ', 'admin', 'Enterprise', 25),
            ('demo@wppflow.io', $2, 'Aarav Mehta', 'Urban Threads', 'user', 'Growth', 5)
        `, [adminHash, demoHash]);
        console.log('🌱 Seeded default users into PostgreSQL');
      }
    } catch (err) {
      console.error('Error seeding PG users:', err.message);
    }
  }

  memoryUsers.set('admin@wppflow.io', { id: 1, email: 'admin@wppflow.io', password_hash: adminHash, name: 'Super Admin', company_name: 'WppFlow HQ', role: 'admin', plan: 'Enterprise', sessions_limit: 25, created_at: new Date().toISOString() });
  memoryUsers.set('demo@wppflow.io', { id: 2, email: 'demo@wppflow.io', password_hash: demoHash, name: 'Aarav Mehta', company_name: 'Urban Threads', role: 'user', plan: 'Growth', sessions_limit: 5, created_at: new Date().toISOString() });
}

// ─── USERS ───────────────────────────────────────────────────────────────────

export async function createUser({ email, password, name, company_name = 'WppFlow Workspace', role = 'user', plan = 'Growth', sessions_limit = 5 }) {
  const password_hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();

  if (isPgConnected && pool) {
    try {
      const res = await pool.query(`
        INSERT INTO users (email, password_hash, name, company_name, role, plan, sessions_limit)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, email, name, company_name, role, plan, sessions_limit, created_at
      `, [normalizedEmail, password_hash, name.trim(), company_name.trim(), role, plan, sessions_limit]);
      const user = res.rows[0];
      memoryUsers.set(normalizedEmail, { ...user, password_hash });
      return user;
    } catch (err) {
      if (err.code === '23505') throw new Error('Email already registered');
      console.warn('PG write error, falling back to memory:', err.message);
    }
  }

  if (memoryUsers.has(normalizedEmail)) throw new Error('Email already registered');
  const newUser = { id: memoryUsers.size + 1, email: normalizedEmail, password_hash, name: name.trim(), company_name: company_name.trim(), role, plan, sessions_limit, created_at: new Date().toISOString() };
  memoryUsers.set(normalizedEmail, newUser);
  const { password_hash: _, ...safeUser } = newUser;
  return safeUser;
}

export async function findUserByEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (err) { console.warn('PG read error:', err.message); }
  }
  return memoryUsers.get(normalizedEmail) || null;
}

export async function findUserById(id) {
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT id, email, name, company_name, role, plan, sessions_limit, created_at FROM users WHERE id = $1', [id]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (err) { console.warn('PG read error:', err.message); }
  }
  for (const user of memoryUsers.values()) {
    if (user.id === Number(id)) { const { password_hash: _, ...s } = user; return s; }
  }
  return null;
}

export async function getAllUsers() {
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT id, email, name, company_name, role, plan, sessions_limit, created_at FROM users ORDER BY id DESC');
      return res.rows;
    } catch (err) { console.warn('PG read error:', err.message); }
  }
  return Array.from(memoryUsers.values()).map(({ password_hash: _, ...s }) => s);
}

/** Return the user ids that share the authenticated user's workspace. */
export async function getWorkspaceUserIds(userId) {
  const user = await findUserById(userId);
  if (!user) return [];
  if (user.role === 'superadmin' || user.email === process.env.SUPERADMIN_EMAIL || user.email === 'admin@wppflow.io') {
    return (await getAllUsers()).map((entry) => Number(entry.id));
  }
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT id FROM users WHERE company_name = $1', [user.company_name]);
      return res.rows.map((entry) => Number(entry.id));
    } catch (err) { console.warn('PG workspace read error:', err.message); }
  }
  return Array.from(memoryUsers.values())
    .filter((entry) => entry.company_name === user.company_name)
    .map((entry) => Number(entry.id));
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

export async function getContacts(userId) {
  const workspaceUserIds = await getWorkspaceUserIds(userId);
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT * FROM contacts WHERE user_id = ANY($1::int[]) ORDER BY created_at DESC', [workspaceUserIds]);
      return res.rows.map(normalizeContact);
    } catch (err) { console.warn('PG contacts read error:', err.message); }
  }
  return Array.from(memoryContacts.values()).filter(c => workspaceUserIds.includes(Number(c.user_id))).map(normalizeContact);
}

export async function createContact(userId, data) {
  const id = `cont_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const contact = { id, user_id: userId, name: data.name, phone: data.phone, email: data.email || '', avatar: data.avatar || '', tags: data.tags || [], custom_traits: data.customTraits || {}, lifetime_value: data.lifetimeValue || 0, channel: data.channel || 'general', last_seen: 'Just now', assigned_agent: data.assignedAgent || '', created_at: new Date().toISOString() };

  if (isPgConnected && pool) {
    try {
      await pool.query(`INSERT INTO contacts (id, user_id, name, phone, email, avatar, tags, custom_traits, lifetime_value, channel, last_seen, assigned_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, userId, contact.name, contact.phone, contact.email, contact.avatar, JSON.stringify(contact.tags), JSON.stringify(contact.custom_traits), contact.lifetime_value, contact.channel, contact.last_seen, contact.assigned_agent]);
      return normalizeContact(contact);
    } catch (err) { console.warn('PG contact create error:', err.message); }
  }
  memoryContacts.set(id, contact);
  return normalizeContact(contact);
}

export async function deleteContact(userId, contactId) {
  if (isPgConnected && pool) {
    try {
      await pool.query('DELETE FROM contacts WHERE id = $1 AND user_id = $2', [contactId, userId]);
      return true;
    } catch (err) { console.warn('PG contact delete error:', err.message); }
  }
  memoryContacts.delete(contactId);
  return true;
}

function normalizeContact(row) {
  return {
    id: row.id, user_id: row.user_id, name: row.name, phone: row.phone, email: row.email,
    avatar: row.avatar, tags: row.tags || [], customTraits: row.custom_traits || {},
    lifetimeValue: parseFloat(row.lifetime_value) || 0, channel: row.channel,
    lastSeen: row.last_seen, assignedAgent: row.assigned_agent, orders: [], notes: [],
    created_at: row.created_at
  };
}

// ─── CHATS ───────────────────────────────────────────────────────────────────

export async function getChats(userId) {
  const workspaceUserIds = await getWorkspaceUserIds(userId);
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT * FROM chats WHERE user_id = ANY($1::int[]) ORDER BY created_at DESC', [workspaceUserIds]);
      return res.rows.map(normalizeChat);
    } catch (err) { console.warn('PG chats read error:', err.message); }
  }
  return Array.from(memoryChats.values()).filter(c => workspaceUserIds.includes(Number(c.user_id))).map(normalizeChat);
}

export async function createChat(userId, data) {
  const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const chat = { id, user_id: userId, contact_id: data.contactId || '', contact_name: data.contactName, phone: data.phone, avatar: data.avatar || '', unread_count: 0, is_group: data.isGroup || false, group_members_count: data.groupMembersCount || 0, channel: data.channel || 'sales', assigned_to: data.assignedTo || '', is_closed: false, last_message: data.lastMessage || {}, tags: data.tags || [], created_at: new Date().toISOString() };

  if (isPgConnected && pool) {
    try {
      await pool.query(`INSERT INTO chats (id, user_id, contact_id, contact_name, phone, avatar, unread_count, is_group, group_members_count, channel, assigned_to, is_closed, last_message, tags) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, userId, chat.contact_id, chat.contact_name, chat.phone, chat.avatar, 0, chat.is_group, chat.group_members_count, chat.channel, chat.assigned_to, false, JSON.stringify(chat.last_message), JSON.stringify(chat.tags)]);
      return normalizeChat(chat);
    } catch (err) { console.warn('PG chat create error:', err.message); }
  }
  memoryChats.set(id, chat);
  return normalizeChat(chat);
}

export async function updateChat(userId, chatId, updates) {
  const workspaceUserIds = await getWorkspaceUserIds(userId);
  if (isPgConnected && pool) {
    try {
      const fields = [];
      const vals = [];
      let i = 1;
      if (updates.assignedTo !== undefined) { fields.push(`assigned_to = $${i++}`); vals.push(updates.assignedTo); }
      if (updates.isClosed !== undefined) { fields.push(`is_closed = $${i++}`); vals.push(updates.isClosed); }
      if (updates.unreadCount !== undefined) { fields.push(`unread_count = $${i++}`); vals.push(updates.unreadCount); }
      if (updates.lastMessage !== undefined) { fields.push(`last_message = $${i++}`); vals.push(JSON.stringify(updates.lastMessage)); }
      if (fields.length === 0) return;
      vals.push(chatId, workspaceUserIds);
      await pool.query(`UPDATE chats SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = ANY($${i}::int[])`, vals);
    } catch (err) { console.warn('PG chat update error:', err.message); }
  }
  if (memoryChats.has(chatId)) {
    const c = memoryChats.get(chatId);
    if (!workspaceUserIds.includes(Number(c?.user_id))) return;
    memoryChats.set(chatId, { ...c, ...updates });
  }
}

function normalizeChat(row) {
  return {
    id: row.id, contactId: row.contact_id, contactName: row.contact_name, phone: row.phone,
    avatar: row.avatar, unreadCount: row.unread_count || 0, isGroup: row.is_group || false,
    groupMembersCount: row.group_members_count || 0, channel: row.channel,
    assignedTo: row.assigned_to, isClosed: row.is_closed || false,
    lastMessage: row.last_message || {}, tags: row.tags || [], created_at: row.created_at
  };
}

// ─── MESSAGES ────────────────────────────────────────────────────────────────

export async function getMessages(chatId, userId = null) {
  const workspaceUserIds = userId ? await getWorkspaceUserIds(userId) : null;
  if (isPgConnected && pool) {
    try {
      const params = userId ? [chatId, workspaceUserIds] : [chatId];
      const accessClause = userId ? ' AND c.user_id = ANY($2::int[])' : '';
      const res = await pool.query(`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.chat_id = $1${accessClause} ORDER BY m.created_at ASC`, params);
      return res.rows.map(normalizeMessage);
    } catch (err) { console.warn('PG messages read error:', err.message); }
  }
  const chat = memoryChats.get(chatId);
  if (userId && !workspaceUserIds.includes(Number(chat?.user_id))) return [];
  return (memoryMessages.get(chatId) || []).map(normalizeMessage);
}

export async function createMessage(chatId, data, userId = null) {
  if (userId) {
    const workspaceUserIds = await getWorkspaceUserIds(userId);
    let ownerId = null;
    if (isPgConnected && pool) {
      const result = await pool.query('SELECT user_id FROM chats WHERE id = $1', [chatId]);
      ownerId = result.rows[0]?.user_id;
    } else {
      ownerId = memoryChats.get(chatId)?.user_id;
    }
    if (!workspaceUserIds.includes(Number(ownerId))) throw new Error('Chat is outside the current workspace');
  }
  const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const msg = { id, chat_id: chatId, sender: data.sender, agent_name: data.agentName || '', text: data.text || '', type: data.type || 'text', media_url: data.mediaUrl || '', file_name: data.fileName || '', file_size: data.fileSize || '', audio_duration: data.audioDuration || '', buttons: data.buttons || [], is_note: data.isNote || false, status: data.status || 'sent', timestamp: data.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), created_at: new Date().toISOString() };

  if (isPgConnected && pool) {
    try {
      await pool.query(`INSERT INTO messages (id, chat_id, sender, agent_name, text, type, media_url, file_name, file_size, audio_duration, buttons, is_note, status, timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, chatId, msg.sender, msg.agent_name, msg.text, msg.type, msg.media_url, msg.file_name, msg.file_size, msg.audio_duration, JSON.stringify(msg.buttons), msg.is_note, msg.status, msg.timestamp]);
      return normalizeMessage(msg);
    } catch (err) { console.warn('PG message create error:', err.message); }
  }
  const list = memoryMessages.get(chatId) || [];
  list.push(msg);
  memoryMessages.set(chatId, list);
  return normalizeMessage(msg);
}

export async function updateMessageStatus(messageId, status) {
  if (isPgConnected && pool) {
    try {
      await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [status, messageId]);
    } catch (err) { console.warn('PG message status update error:', err.message); }
  }
}

function normalizeMessage(row) {
  return {
    id: row.id, chatId: row.chat_id, sender: row.sender, agentName: row.agent_name,
    text: row.text, type: row.type, mediaUrl: row.media_url, fileName: row.file_name,
    fileSize: row.file_size, audioDuration: row.audio_duration, buttons: row.buttons || [],
    isNote: row.is_note || false, status: row.status, timestamp: row.timestamp,
    created_at: row.created_at
  };
}

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

export async function getCampaigns(userId) {
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT * FROM campaigns WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      return res.rows.map(normalizeCampaign);
    } catch (err) { console.warn('PG campaigns read error:', err.message); }
  }
  return Array.from(memoryCampaigns.values()).filter(c => c.user_id === userId).map(normalizeCampaign);
}

export async function createCampaign(userId, data) {
  const id = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const camp = { id, user_id: userId, name: data.name, target_segment: data.targetSegment || '', total_recipients: data.totalRecipients || 0, sent_count: data.sentCount || 0, delivered_count: data.deliveredCount || 0, read_count: data.readCount || 0, replied_count: data.repliedCount || 0, failed_count: data.failedCount || 0, cost_saved_meta: data.costSavedMeta || 0, status: data.status || 'draft', template_text: data.templateText || '', anti_ban_delay_seconds: data.antiBanDelaySeconds || 4, scheduled_for: data.scheduledFor || '', created_at: new Date().toISOString() };

  if (isPgConnected && pool) {
    try {
      await pool.query(`INSERT INTO campaigns (id, user_id, name, target_segment, total_recipients, sent_count, delivered_count, read_count, replied_count, failed_count, cost_saved_meta, status, template_text, anti_ban_delay_seconds, scheduled_for) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, userId, camp.name, camp.target_segment, camp.total_recipients, camp.sent_count, camp.delivered_count, camp.read_count, camp.replied_count, camp.failed_count, camp.cost_saved_meta, camp.status, camp.template_text, camp.anti_ban_delay_seconds, camp.scheduled_for]);
      return normalizeCampaign(camp);
    } catch (err) { console.warn('PG campaign create error:', err.message); }
  }
  memoryCampaigns.set(id, camp);
  return normalizeCampaign(camp);
}

function normalizeCampaign(row) {
  return {
    id: row.id, name: row.name, targetSegment: row.target_segment,
    totalRecipients: row.total_recipients, sentCount: row.sent_count,
    deliveredCount: row.delivered_count, readCount: row.read_count,
    repliedCount: row.replied_count, failedCount: row.failed_count,
    costSavedMeta: parseFloat(row.cost_saved_meta) || 0, status: row.status,
    templateText: row.template_text, antiBanDelaySeconds: row.anti_ban_delay_seconds,
    scheduledFor: row.scheduled_for, createdAt: row.created_at
  };
}

// ─── AUTOMATIONS ─────────────────────────────────────────────────────────────

export async function getAutomations(userId) {
  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT * FROM automations WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
      return res.rows.map(normalizeAutomation);
    } catch (err) { console.warn('PG automations read error:', err.message); }
  }
  return Array.from(memoryAutomations.values()).filter(a => a.user_id === userId).map(normalizeAutomation);
}

export async function createAutomation(userId, data) {
  const id = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const auto = { id, user_id: userId, name: data.name, trigger_type: data.triggerType || 'keyword', trigger_condition: data.triggerCondition || '', action_type: data.actionType || 'reply_text', action_summary: data.actionSummary || '', is_enabled: data.isEnabled !== false, executions_count: 0, created_at: new Date().toISOString() };

  if (isPgConnected && pool) {
    try {
      await pool.query(`INSERT INTO automations (id, user_id, name, trigger_type, trigger_condition, action_type, action_summary, is_enabled, executions_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, userId, auto.name, auto.trigger_type, auto.trigger_condition, auto.action_type, auto.action_summary, auto.is_enabled, 0]);
      return normalizeAutomation(auto);
    } catch (err) { console.warn('PG automation create error:', err.message); }
  }
  memoryAutomations.set(id, auto);
  return normalizeAutomation(auto);
}

export async function toggleAutomation(userId, automationId) {
  if (isPgConnected && pool) {
    try {
      await pool.query('UPDATE automations SET is_enabled = NOT is_enabled WHERE id = $1 AND user_id = $2', [automationId, userId]);
      const res = await pool.query('SELECT * FROM automations WHERE id = $1', [automationId]);
      return res.rows[0] ? normalizeAutomation(res.rows[0]) : null;
    } catch (err) { console.warn('PG automation toggle error:', err.message); }
  }
  if (memoryAutomations.has(automationId)) {
    const a = memoryAutomations.get(automationId);
    const updated = { ...a, is_enabled: !a.is_enabled };
    memoryAutomations.set(automationId, updated);
    return normalizeAutomation(updated);
  }
  return null;
}

export async function deleteAutomation(userId, automationId) {
  if (isPgConnected && pool) {
    try {
      await pool.query('DELETE FROM automations WHERE id = $1 AND user_id = $2', [automationId, userId]);
      return true;
    } catch (err) { console.warn('PG automation delete error:', err.message); }
  }
  memoryAutomations.delete(automationId);
  return true;
}

function normalizeAutomation(row) {
  return {
    id: row.id, name: row.name, triggerType: row.trigger_type,
    triggerCondition: row.trigger_condition, actionType: row.action_type,
    actionSummary: row.action_summary, isEnabled: row.is_enabled,
    executionsCount: row.executions_count || 0, createdAt: row.created_at
  };
}

// ─── STATUS ──────────────────────────────────────────────────────────────────

export function getDatabaseStatus() {
  return {
    isPgConnected,
    type: isPgConnected ? 'PostgreSQL' : 'In-Memory (Fault Tolerant)',
    totalUsers: isPgConnected ? 'Postgres Active' : memoryUsers.size
  };
}

export function getPool() { return pool; }
