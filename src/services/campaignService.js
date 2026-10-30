import crypto from "node:crypto";
import { assertRoomForBroadcast } from "./limitsService.js";
import { query, withTransaction } from "../db/index.js";
import { sendTextMessage } from "./messageService.js";
import { fail } from "../middleware/http.js";
import { personalise } from "./templating.js";
export const campaignView = (c) => ({
  ...c,
  targetSegment: c.target_segment,
  totalRecipients: c.total_recipients,
  sentCount: c.sent_count,
  deliveredCount: c.delivered_count,
  readCount: c.read_count,
  repliedCount: null,
  failedCount: c.failed_count,
  costSavedMeta: null,
  templateText: c.template_text,
  antiBanDelaySeconds: c.anti_ban_delay_seconds,
  sessionName: c.session_name,
  createdAt: c.created_at,
  scheduledFor: c.scheduled_for,
  batchSize: c.batch_size ?? 25,
  cooldownSeconds: c.cooldown_seconds ?? 300,
  cooldownUntil: c.cooldown_until || null,
  circuitBreakerTripped: Boolean(c.circuit_breaker_tripped),
  consecutiveFailures: c.consecutive_failures ?? 0,
  spintaxEnabled: c.spintax_enabled !== false,
  typingSimulation: c.typing_simulation !== false,
});
const ALL = "All Contacts";
// Who a broadcast to this audience would reach, and who it would leave out and why. `tag` is a contact tag, or
// "All Contacts". Someone who said STOP, or who is on the do-not-contact list, is never reached.
export async function audienceFor(tenantId, tag = ALL) {
  const segment = tag || ALL;
  const state = `CASE WHEN s.id IS NOT NULL OR x.opt_in_status IS FALSE THEN 'opted_out' WHEN x.id IS NULL THEN 'not_asked' ELSE 'will_receive' END`;
  const base = `FROM contacts c
    LEFT JOIN consents x ON x.tenant_id=c.tenant_id AND x.phone=c.phone
    LEFT JOIN suppressions s ON s.tenant_id=c.tenant_id AND s.phone=c.phone`;
  const { rows } = await query(
    `SELECT ${state} AS state,count(*)::int AS n ${base} WHERE c.tenant_id=$1 AND ($2::text=$3 OR c.tags ? $2::text) GROUP BY 1`,
    [tenantId, segment, ALL],
  );
  const by = Object.fromEntries(rows.map((r) => [r.state, r.n]));
  const tags = await query(
    `SELECT t.tag,count(*)::int AS count,count(*) FILTER (WHERE ${state}='will_receive')::int AS will_receive
     ${base}, jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.tags)='array' THEN c.tags ELSE '[]'::jsonb END) AS t(tag)
     WHERE c.tenant_id=$1 GROUP BY t.tag ORDER BY count DESC,t.tag LIMIT 60`,
    [tenantId],
  );
  const stop = await query("SELECT bool_or(is_enabled) AS enabled FROM automations WHERE tenant_id=$1 AND action_type='opt_out'", [tenantId]);
  return {
    tag: segment,
    willReceive: by.will_receive || 0,
    notAsked: by.not_asked || 0,
    optedOut: by.opted_out || 0,
    total: (by.will_receive || 0) + (by.not_asked || 0) + (by.opted_out || 0),
    tags: tags.rows.map((r) => ({ tag: r.tag, count: r.count, willReceive: r.will_receive })),
    unsubscribeRule: { exists: stop.rows[0].enabled !== null, enabled: stop.rows[0].enabled === true },
  };
}

// Records permission for contacts nobody has decided on yet. Someone who opted out stays opted out.
export async function recordPermission(tenantId, tag = ALL, actorId = null) {
  const { rowCount } = await query(
    `INSERT INTO consents(tenant_id,phone,opt_in_status,source)
     SELECT c.tenant_id,c.phone,true,'workspace_bulk' FROM contacts c
     WHERE c.tenant_id=$1 AND ($2::text=$3 OR c.tags ? $2::text)
       AND NOT EXISTS(SELECT 1 FROM consents x WHERE x.tenant_id=c.tenant_id AND x.phone=c.phone)
       AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.tenant_id=c.tenant_id AND s.phone=c.phone)
     ON CONFLICT DO NOTHING`,
    [tenantId, tag || ALL, ALL],
  );
  await query("INSERT INTO audit_events(tenant_id,actor_id,event_type,metadata) VALUES($1,$2,'consent.bulk_recorded',$3)", [
    tenantId,
    actorId,
    JSON.stringify({ audience: tag || ALL, recorded: rowCount }),
  ]);
  return rowCount;
}

export async function duplicateCampaign(tenantId, id) {
  const { rows } = await query(
    `INSERT INTO campaigns(id,tenant_id,name,target_segment,template_text,session_name,anti_ban_delay_seconds,scheduled_for,batch_size,cooldown_seconds,spintax_enabled,typing_simulation)
     SELECT $3,tenant_id,left(name,240) || ' (copy)',target_segment,template_text,session_name,anti_ban_delay_seconds,'',batch_size,cooldown_seconds,spintax_enabled,typing_simulation FROM campaigns WHERE id=$1 AND tenant_id=$2 RETURNING *`,
    [id, tenantId, crypto.randomUUID()],
  );
  if (!rows[0]) throw fail(404, "Campaign not found");
  return campaignView(rows[0]);
}

export async function startCampaign(tenantId, id) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      "SELECT * FROM campaigns WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
      [id, tenantId],
    );
    const camp = rows[0];
    if (!camp) throw fail(404, "Campaign not found");
    if (camp.status === "completed")
      throw fail(409, "Completed campaigns cannot be restarted");
    // the plan's monthly broadcast limit: starts are counted one company at a time, so two at once cannot both slip in
    await c.query("SELECT 1 FROM tenants WHERE id=$1 FOR UPDATE", [tenantId]);
    await assertRoomForBroadcast(tenantId, camp, (sql, params) =>
      c.query(sql, params),
    );
    const session = await c.query(
      "SELECT id FROM whatsapp_sessions WHERE tenant_id=$1 AND session_name=$2",
      [tenantId, camp.session_name],
    );
    if (!session.rowCount)
      throw fail(400, "Select a workspace WhatsApp session");
    await c.query(
      `INSERT INTO campaign_recipients(tenant_id,campaign_id,phone)
      SELECT $1::varchar,$2::varchar,c.phone FROM contacts c JOIN consents x ON x.tenant_id=c.tenant_id AND x.phone=c.phone AND x.opt_in_status=true
      WHERE c.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM suppressions s WHERE s.tenant_id=c.tenant_id AND s.phone=c.phone)
      AND ($3='All Contacts' OR c.tags ? $3) ON CONFLICT DO NOTHING`,
      [tenantId, id, camp.target_segment],
    );
    const count = await c.query(
      "SELECT count(*)::int AS count FROM campaign_recipients WHERE tenant_id=$1 AND campaign_id=$2",
      [tenantId, id],
    );
    if (!count.rows[0].count)
      throw fail(400, "No opted-in recipients match this segment");
    const updated = await c.query(
      "UPDATE campaigns SET status='running',circuit_breaker_tripped=false,consecutive_failures=0,total_recipients=$1,started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$2 AND tenant_id=$3 RETURNING *",
      [count.rows[0].count, id, tenantId],
    );
    return campaignView(updated.rows[0]);
  });
}
async function claimRecipient(campaign) {
  return withTransaction(async (c) => {
    const lock = await c.query(
      `SELECT * FROM campaigns 
       WHERE id=$1 AND tenant_id=$2 AND status='running' 
         AND (cooldown_until IS NULL OR cooldown_until <= now())
         AND updated_at < now()-make_interval(secs=>GREATEST(anti_ban_delay_seconds,4)) 
       FOR UPDATE SKIP LOCKED`,
      [campaign.id, campaign.tenant_id],
    );
    if (!lock.rowCount) return null;
    const currentCamp = lock.rows[0];

    const result = await c.query(
      "SELECT * FROM campaign_recipients WHERE campaign_id=$1 AND tenant_id=$2 AND (status='pending' OR (status='preparing' AND claimed_at<now()-interval '2 minutes')) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
      [campaign.id, campaign.tenant_id],
    );
    const r = result.rows[0];
    if (!r) return null;
    const consent = await c.query(
      "SELECT 1 FROM consents WHERE tenant_id=$1 AND phone=$2 AND opt_in_status=true AND NOT EXISTS(SELECT 1 FROM suppressions WHERE tenant_id=$1 AND phone=$2)",
      [r.tenant_id, r.phone],
    );
    if (!consent.rowCount) {
      await c.query(
        "UPDATE campaign_recipients SET status='suppressed' WHERE id=$1",
        [r.id],
      );
      return null;
    }
    const contact = await c.query(
      "SELECT * FROM contacts WHERE tenant_id=$1 AND phone=$2",
      [r.tenant_id, r.phone],
    );
    const jid = r.phone.includes("@")
      ? r.phone
      : `${r.phone.replace(/\D/g, "")}@c.us`;
    const conv = await c.query(
      `INSERT INTO conversations(id,tenant_id,session_name,provider_chat_id,phone,contact_name,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(tenant_id,session_name,provider_chat_id) DO UPDATE SET updated_at=conversations.updated_at RETURNING id`,
      [
        crypto.randomUUID(),
        r.tenant_id,
        campaign.session_name,
        jid,
        r.phone,
        contact.rows[0]?.name || r.phone,
        contact.rows[0]?.id || null,
      ],
    );
    await c.query(
      "UPDATE campaign_recipients SET status='preparing',claimed_at=now() WHERE id=$1",
      [r.id],
    );

    const batchSize = Math.max(5, currentCamp.batch_size || 25);
    const cooldownSecs = Math.max(30, currentCamp.cooldown_seconds || 300);
    const claimedCountRes = await c.query(
      "SELECT count(*)::int AS count FROM campaign_recipients WHERE campaign_id=$1 AND tenant_id=$2 AND status != 'pending'",
      [campaign.id, campaign.tenant_id],
    );
    const alreadyClaimed = claimedCountRes.rows[0]?.count || 0;
    const remainingPendingRes = await c.query(
      "SELECT count(*)::int AS count FROM campaign_recipients WHERE campaign_id=$1 AND tenant_id=$2 AND status = 'pending' AND id != $3",
      [campaign.id, campaign.tenant_id, r.id],
    );
    const remainingPending = remainingPendingRes.rows[0]?.count || 0;

    if (remainingPending > 0 && alreadyClaimed % batchSize === 0) {
      await c.query(
        "UPDATE campaigns SET cooldown_until=now()+make_interval(secs=>$1), updated_at=now() WHERE id=$2",
        [cooldownSecs, campaign.id],
      );
    } else {
      await c.query("UPDATE campaigns SET updated_at=now() WHERE id=$1", [
        campaign.id,
      ]);
    }

    return {
      ...r,
      conversationId: conv.rows[0].id,
      name: contact.rows[0]?.name || r.phone,
    };
  });
}
export async function pumpCampaigns(io) {
  const { rows: campaigns } = await query(
    "SELECT * FROM campaigns WHERE status='running' AND (scheduled_for='' OR scheduled_for::timestamptz<=now()) ORDER BY created_at LIMIT 25",
  );
  for (const campaign of campaigns) {
    const company = (await query("SELECT name FROM tenants WHERE id=$1", [campaign.tenant_id])).rows[0]?.name || "";
    const r = await claimRecipient(campaign);
    if (r) {
      try {
        // Stable identity recovers a crash between message creation and recipient linkage.
        const result = await sendTextMessage({
          tenantId: r.tenant_id,
          conversationId: r.conversationId,
          text: personalise(campaign.template_text, { name: r.name, company }),
          idempotencyKey: `campaign:${campaign.id}:${r.id}`,
          agentName: "Campaign",
          io,
          campaignId: campaign.id,
        });
        await query(
          "UPDATE campaign_recipients SET status='queued',message_id=$1 WHERE id=$2 AND tenant_id=$3",
          [result.message.id, r.id, r.tenant_id],
        );
      } catch (error) {
        if (error.status === 400 || error.status === 403)
          await query(
            "UPDATE campaign_recipients SET status='failed' WHERE id=$1 AND tenant_id=$2",
            [r.id, r.tenant_id],
          );
        else throw error;
      }
    }
    await query(
      `UPDATE campaigns SET
      sent_count=(SELECT count(*) FROM campaign_recipients r JOIN messages m ON m.id=r.message_id WHERE r.campaign_id=$1 AND m.ack>=1),
      delivered_count=(SELECT count(*) FROM campaign_recipients r JOIN messages m ON m.id=r.message_id WHERE r.campaign_id=$1 AND m.ack>=2),
      read_count=(SELECT count(*) FROM campaign_recipients r JOIN messages m ON m.id=r.message_id WHERE r.campaign_id=$1 AND m.ack>=3),
      failed_count=(SELECT count(*) FROM campaign_recipients r LEFT JOIN messages m ON m.id=r.message_id WHERE r.campaign_id=$1 AND (r.status='failed' OR m.status='failed'))
      WHERE id=$1 AND tenant_id=$2`,
      [campaign.id, campaign.tenant_id],
    );
    await query(
      `UPDATE campaigns SET status='completed' WHERE id=$1 AND tenant_id=$2 AND status='running' AND NOT EXISTS(SELECT 1 FROM campaign_recipients r LEFT JOIN messages m ON m.id=r.message_id WHERE r.campaign_id=$1 AND (r.status IN ('pending','preparing') OR m.status IN ('sending','dispatching','uncertain')))`,
      [campaign.id, campaign.tenant_id],
    );
    io?.to(`tenant:${campaign.tenant_id}`).emit("campaign:progress", {
      campaignId: campaign.id,
    });
  }
}
