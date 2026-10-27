import request from "supertest";
import { app } from "../../src/server.js";
import { query } from "../../src/db/index.js";
import { registerTenantAndUser, generateAccessToken } from "../../src/services/authService.js";
import { handleIncomingMessage } from "../../src/services/messageService.js";
import { setSolution } from "../../src/solutions/entitlements.js";

// A real-estate company for tests: an owner, an administrator and two agents who each have their own WhatsApp number.
let counter = 0;
export async function company(label, { plan = "Growth", solution = true } = {}) {
  const n = ++counter;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const o = await registerTenantAndUser({ name: `${label} Owner`, email: `owner.${slug}${n}@re.test`, password: "Password@123", companyName: label });
  const tenantId = o.tenant.id;
  await query("UPDATE tenants SET plan=$2 WHERE id=$1", [tenantId, plan]);
  const person = async (name, role) => {
    const u = (await registerTenantAndUser({ name, email: `${name.toLowerCase().replace(/\W+/g, ".")}.${slug}${n}@re.test`, password: "Password@123", companyName: `${name}'s own ${n}` })).user;
    await query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,$3)", [tenantId, u.id, role]);
    return { ...u, role, auth: { Authorization: `Bearer ${generateAccessToken(u, tenantId, role)}` } };
  };
  const owner = { ...o.user, role: "owner", auth: { Authorization: `Bearer ${generateAccessToken(o.user, tenantId, "owner")}` } };
  const admin = await person("Ada Admin", "admin");
  const sam = await person("Sam Agent", "agent");
  const tina = await person("Tina Agent", "agent");
  for (const [name, who] of [["sam-line", sam], ["tina-line", tina], ["front-desk", owner]])
    await query("INSERT INTO whatsapp_sessions(id,tenant_id,session_name,owner_user_id,status) VALUES(gen_random_uuid()::text,$1,$2,$3,'CONNECTED')", [tenantId, name, who.id]);
  if (solution) await setSolution({ tenantId, key: "real_estate", enabled: true, actor: null });

  let seq = 0;
  // A customer writes on one of the numbers: this makes the contact and the chat, as in real life.
  const customer = async (phone, name, { line = "sam-line", text = "hello", ago = 0 } = {}) => {
    seq += 1;
    await handleIncomingMessage({
      tenantId,
      sessionName: line,
      msg: { providerMessageId: `true_${phone}@c.us_${n}_${seq}`, fromMe: false, remoteId: `${phone}@c.us`, rawType: "chat", type: "text", text, timestampEpoch: Math.floor(Date.now() / 1000) - ago + seq, senderName: name, ack: 2 },
    });
    const contact = (await query("SELECT id FROM contacts WHERE tenant_id=$1 AND phone=$2", [tenantId, phone])).rows[0].id;
    const chat = (await query("SELECT id FROM conversations WHERE tenant_id=$1 AND contact_id=$2 AND session_name=$3", [tenantId, contact, line])).rows[0].id;
    return { contact, chat, phone, name, line };
  };
  const re = (who) => ({
    get: (path) => request(app).get(`/api/solutions/real_estate${path}`).set(who.auth),
    post: (path, body = {}) => request(app).post(`/api/solutions/real_estate${path}`).set(who.auth).send(body),
    put: (path, body = {}) => request(app).put(`/api/solutions/real_estate${path}`).set(who.auth).send(body),
    patch: (path, body = {}) => request(app).patch(`/api/solutions/real_estate${path}`).set(who.auth).send(body),
    del: (path) => request(app).delete(`/api/solutions/real_estate${path}`).set(who.auth),
  });
  const core = (who) => ({
    get: (path) => request(app).get(`/api/leads${path}`).set(who.auth),
    post: (path, body = {}) => request(app).post(`/api/leads${path}`).set(who.auth).send(body),
    patch: (path, body = {}) => request(app).patch(`/api/leads${path}`).set(who.auth).send(body),
  });
  // A lead for a customer, made the normal way from the chat, optionally given to someone.
  const lead = async (cust, { owner: ownerOf = null, value = 0, as = owner } = {}) => {
    const made = await core(as).post("", { conversationId: cust.chat, value });
    if (made.status !== 201 && made.status !== 200) throw new Error(`lead not made: ${made.status} ${JSON.stringify(made.body)}`);
    const id = made.body.lead.id;
    if (ownerOf) await core(owner).patch(`/${id}`, { ownerUserId: ownerOf.id });
    return id;
  };
  return { tenantId, owner, admin, sam, tina, customer, re, core, lead, n };
}

export const property = (o = {}) => ({
  reference: "DM-101", title: "Marina view two bedroom", purpose: "sale", status: "available", price: 1_400_000, currency: "AED", community: "Dubai Marina",
  propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqft: 1100, listingUrl: "https://listings.example.test/dm-101", ...o,
});
export const BUYER = { leadType: "buyer", budgetMax: 1_500_000, currency: "AED", communities: ["Dubai Marina"], propertyTypes: ["apartment"], bedroomsMin: 2, bedroomsMax: 3, timeline: "3_months" };
