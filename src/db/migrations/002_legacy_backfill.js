export const version = "002_legacy_backfill";
export async function up(client) {
  const { rows: tables } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'legacy_%'",
  );
  const has = new Set(tables.map((t) => t.table_name));
  if (!has.size) return;
  const { rows: users } = await client.query("SELECT * FROM users ORDER BY id");
  const mapping = JSON.parse(process.env.LEGACY_TENANT_MAP || "{}");
  const companies = new Map();
  for (const u of users) {
    const label = String(u.company_name || "")
      .trim()
      .toLowerCase();
    if (label) companies.set(label, [...(companies.get(label) || []), u.id]);
  }
  for (const ids of companies.values())
    if (ids.length > 1 && ids.some((id) => !mapping[id])) {
      throw new Error(
        "Legacy team ownership is ambiguous. Set LEGACY_TENANT_MAP to an explicit user-id to tenant-id mapping before migration.",
      );
    }
  const userTenant = new Map();
  users.sort(
    (a, b) =>
      Number(b.role === "admin") - Number(a.role === "admin") || a.id - b.id,
  );
  for (const u of users) {
    const current = await client.query(
      "SELECT tenant_id FROM memberships WHERE user_id=$1",
      [u.id],
    );
    if (!mapping[u.id] && current.rowCount === 1) {
      userTenant.set(u.id, current.rows[0].tenant_id);
      continue;
    }
    if (!mapping[u.id] && current.rowCount > 1)
      throw new Error(
        "Legacy owner has multiple workspaces; explicit mapping required",
      );
    const tenantId = mapping[u.id] || `tenant_user_${u.id}`;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId))
      throw new Error("Invalid legacy tenant mapping");
    await client.query(
      `INSERT INTO tenants(id,name,slug,plan,sessions_limit) VALUES($1,$2,$1,$3,$4) ON CONFLICT(id) DO NOTHING`,
      [
        tenantId,
        u.company_name || `${u.name}'s Workspace`,
        u.plan || "Growth",
        u.sessions_limit || 5,
      ],
    );
    const existing = await client.query(
      "SELECT 1 FROM memberships WHERE tenant_id=$1",
      [tenantId],
    );
    const role = existing.rowCount
      ? u.role === "admin"
        ? "admin"
        : "agent"
      : "owner";
    await client.query(
      "INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [tenantId, u.id, role],
    );
    userTenant.set(u.id, tenantId);
  }
  const contactIds = new Map();
  if (has.has("legacy_contacts")) {
    const { rows } = await client.query("SELECT * FROM legacy_contacts");
    for (const c of rows) {
      const tenant = userTenant.get(c.user_id);
      if (!tenant) throw new Error("Legacy contact has unresolved owner");
      const result = await client.query(
        `INSERT INTO contacts(id,tenant_id,name,phone,email,avatar,tags,custom_traits,lifetime_value,assigned_agent,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(tenant_id,phone) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [
          c.id,
          tenant,
          c.name,
          c.phone,
          c.email || "",
          c.avatar || "",
          JSON.stringify(c.tags || []),
          JSON.stringify(c.custom_traits || {}),
          c.lifetime_value || 0,
          c.assigned_agent || "",
          c.created_at,
        ],
      );
      contactIds.set(c.id, result.rows[0].id);
    }
  }
  const chatIds = new Map();
  if (has.has("legacy_chats")) {
    const { rows } = await client.query("SELECT * FROM legacy_chats");
    for (const c of rows) {
      const tenant = userTenant.get(c.user_id);
      if (!tenant) throw new Error("Legacy conversation has unresolved owner");
      const session = c.channel || "primary-whatsapp";
      const jid = c.phone.includes("@")
        ? c.phone
        : `${c.phone.replace(/\D/g, "")}@c.us`;
      const result = await client.query(
        `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,contact_id,phone,contact_name,avatar,unread_count,is_group,assigned_to,is_closed,last_active_epoch,last_message,tags,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        ON CONFLICT(tenant_id,session_name,provider_chat_id) DO UPDATE SET last_active_epoch=GREATEST(conversations.last_active_epoch,EXCLUDED.last_active_epoch) RETURNING id`,
        [
          c.id,
          tenant,
          session,
          jid,
          contactIds.get(c.contact_id) || null,
          c.phone,
          c.contact_name,
          c.avatar || "",
          c.unread_count || 0,
          c.is_group || false,
          c.assigned_to || "",
          c.is_closed || false,
          c.last_active_epoch ||
            Math.floor(new Date(c.created_at).getTime() / 1000),
          JSON.stringify(c.last_message || {}),
          JSON.stringify(c.tags || []),
          c.created_at,
        ],
      );
      chatIds.set(c.id, { id: result.rows[0].id, tenant });
    }
  }
  if (has.has("legacy_messages")) {
    const { rows } = await client.query("SELECT * FROM legacy_messages");
    for (const m of rows) {
      const chat = chatIds.get(m.chat_id);
      if (!chat) throw new Error("Legacy message has unresolved conversation");
      await client.query(
        `INSERT INTO messages(id,tenant_id,conversation_id,sender,agent_name,text,type,status,ack,media_url,file_name,file_size,audio_duration,timestamp,timestamp_epoch,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(id) DO NOTHING`,
        [
          m.id,
          chat.tenant,
          chat.id,
          m.sender,
          m.agent_name || "",
          m.text || "",
          m.is_note ? "internal_note" : m.type || "text",
          m.status || "sent",
          m.status === "read" ? 3 : m.status === "delivered" ? 2 : 1,
          m.media_url || "",
          m.file_name || "",
          m.file_size || "",
          m.audio_duration || "",
          m.timestamp || "",
          Math.floor(new Date(m.created_at).getTime() / 1000),
          m.created_at,
        ],
      );
    }
  }
  for (const table of ["campaigns", "automations"]) {
    if (!has.has(`legacy_${table}`)) continue;
    const { rows } = await client.query(`SELECT * FROM legacy_${table}`);
    for (const r of rows) {
      const tenant = userTenant.get(r.user_id);
      if (!tenant) throw new Error("Legacy record has unresolved owner");
      if (table === "campaigns")
        await client.query(
          `INSERT INTO campaigns(id,tenant_id,name,target_segment,template_text,status,created_at) VALUES($1,$2,$3,$4,$5,'draft',$6) ON CONFLICT DO NOTHING`,
          [
            r.id,
            tenant,
            r.name,
            r.target_segment || "",
            r.template_text || "",
            r.created_at,
          ],
        );
      else
        await client.query(
          `INSERT INTO automations(id,tenant_id,name,trigger_type,trigger_condition,action_type,action_summary,is_enabled,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8) ON CONFLICT DO NOTHING`,
          [
            r.id,
            tenant,
            r.name,
            r.trigger_type || "keyword",
            r.trigger_condition || "",
            r.action_type || "reply_text",
            r.action_summary || "",
            r.created_at,
          ],
        );
    }
  }
  for (const tenant of new Set(userTenant.values()))
    await client.query(
      `INSERT INTO audit_events(tenant_id,event_type,metadata) VALUES($1,'migration.legacy_preserved',$2)`,
      [
        tenant,
        JSON.stringify({ sessionOwnership: "Explicit attachment required" }),
      ],
    );
}
export async function down() {
  throw new Error(
    "Backfilled data is preserved. Use a forward repair migration.",
  );
}
