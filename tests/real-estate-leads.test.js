import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { closeSessions } from "../src/services/sessionService.js";
import { company, property, BUYER } from "./helpers/realEstate.js";

test("Real estate: qualifying leads, the property inventory and matching", async (t) => {
  t.after(async () => {
    await closeSessions(io);
    io.close();
  });
  const A = await company("Marina Brokers");
  const B = await company("Desert Homes");
  const C = await company("Plain Co", { solution: false });
  const a = (who = A.owner) => A.re(who);
  const asha = await A.customer("971500000001", "Asha", { text: "Hi, I'm looking for a 2 bedroom in Dubai Marina" });
  const ashaLead = await A.lead(asha);

  await t.test("a company without the solution cannot reach any of it, and the universal pipeline still works", async () => {
    for (const path of ["/properties", "/overview", "/viewings", "/alerts", "/meta"]) assert.equal((await C.re(C.owner).get(path)).status, 403, path);
    assert.match((await C.re(C.owner).get("/properties")).body.message, /isn't switched on/);
    assert.equal((await request(app).get("/api/solutions/real_estate/properties")).status, 401);
    assert.equal((await C.core(C.owner).get("/board")).status, 200);
  });

  await t.test("the forms are told what the choices are, by the server", async () => {
    const meta = (await a().get("/meta")).body;
    assert.deepEqual(meta.leadTypes, ["buyer", "tenant", "landlord", "seller", "investor"]);
    assert.ok(meta.propertyTypes.includes("apartment") && meta.propertyTypes.includes("villa"));
    assert.equal(meta.settings.timezone, "Asia/Dubai");
    assert.ok(meta.currencies.includes("AED"));
  });

  await t.test("a lead has no qualification until someone makes one, and says what is missing", async () => {
    const res = await a().get(`/leads/${ashaLead}/profile`);
    assert.equal(res.status, 200);
    assert.equal(res.body.profile, null);
    assert.deepEqual(res.body.missing, ["lead type", "buy or rent"]);
  });

  await t.test("qualification details are checked before they are kept", async () => {
    const put = (body) => a().put(`/leads/${ashaLead}/profile`, body);
    for (const [body, pattern] of [
      [{ leadType: "wizard" }, /Lead type must be one of/],
      [{ leadType: "buyer", budgetMax: 1500000 }, /Say which currency/],
      [{ leadType: "buyer", budgetMin: 2000000, budgetMax: 1000000, currency: "AED" }, /lowest budget is above the highest/],
      [{ leadType: "buyer", budgetMax: -5, currency: "AED" }, /number from 0/],
      [{ leadType: "buyer", currency: "XYZ" }, /Currency must be one of/],
      [{ leadType: "buyer", bedroomsMin: 4, bedroomsMax: 2 }, /fewest bedrooms is above/],
      [{ leadType: "buyer", bedroomsMin: 1.5 }, /whole number/],
      [{ leadType: "buyer", timeline: "someday" }, /Timeline must be one of/],
      [{ leadType: "buyer", propertyTypes: ["castle"] }, /property type must be one of/],
      [{ leadType: "buyer", communities: [""] }, /area is a name/],
      [{ leadType: "tenant", intent: "buy" }, /A tenant deals in rentals, not sales/],
      [{ leadType: "buyer", intent: "rent" }, /A buyer deals in sales, not rentals/],
      [{ leadType: "buyer", qualificationStatus: "disqualified" }, /Say why this lead is not a fit/],
      [{ leadType: "buyer", favouriteColour: "blue" }, /Unknown field/],
      [{ leadType: "buyer", notes: "x".repeat(2001) }, /up to 2000/],
    ])
      assert.match((await put(body)).body.message, pattern, JSON.stringify(body));
    assert.equal((await a().get(`/leads/${ashaLead}/profile`)).body.profile, null, "nothing invalid was saved");
  });

  await t.test("a lead cannot be called qualified until what a search needs is known", async () => {
    const res = await a().put(`/leads/${ashaLead}/profile`, { leadType: "buyer", qualificationStatus: "qualified" });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.missing, ["budget", "an area or a property type", "timeline"]);
    assert.match(res.body.message, /Before this lead can be marked qualified, add: budget, an area or a property type, timeline/);
    const ok = await a().put(`/leads/${ashaLead}/profile`, { ...BUYER, sourceDetail: "Property Finder", nextAction: "Send two listings", qualificationStatus: "qualified" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const p = ok.body.profile;
    assert.equal(p.intent, "buy", "a buyer's intent follows from the type");
    assert.equal(p.budgetMax, 1500000);
    assert.deepEqual(p.communities, ["Dubai Marina"]);
    assert.equal(p.qualificationStatus, "qualified");
    assert.ok(p.qualifiedAt);
    assert.deepEqual(ok.body.missing, []);
    assert.ok(ok.body.changed.includes("budgetMax") && ok.body.changed.includes("qualificationStatus"));
  });

  await t.test("what changed is written to the lead's own history, and saving the same again adds nothing", async () => {
    const timeline = async () => (await A.core(A.owner).get(`/${ashaLead}`)).body.timeline.filter((e) => e.type === "qualification");
    const before = await timeline();
    assert.equal(before.length, 1);
    assert.equal(before[0].detail.status, "qualified");
    assert.ok(before[0].detail.changed.includes("budgetMax"));
    assert.equal((await a().put(`/leads/${ashaLead}/profile`, { budgetMax: 1500000 })).status, 200);
    assert.equal((await timeline()).length, 1, "no change, no entry");
    await a().put(`/leads/${ashaLead}/profile`, { budgetMax: 1600000, assisted: undefined });
    const after = await timeline();
    assert.equal(after.length, 2);
    assert.deepEqual(after[0].detail.changed, ["budgetMax"]);
    assert.equal((await a().get(`/leads/${ashaLead}/profile`)).body.profile.qualifiedAt, (await a().get(`/leads/${ashaLead}/profile`)).body.profile.qualifiedAt);
    await a().put(`/leads/${ashaLead}/profile`, { budgetMax: 1500000 });
  });

  await t.test("a lead can be marked not a fit, with a reason, and goes back to qualified when it is", async () => {
    const lost = await A.customer("971500000002", "Bilal", { text: "just browsing" });
    const id = await A.lead(lost);
    const res = await a().put(`/leads/${id}/profile`, { leadType: "buyer", qualificationStatus: "disqualified", disqualifiedReason: "Only browsing, no budget" });
    assert.equal(res.body.profile.disqualifiedReason, "Only browsing, no budget");
    const back = await a().put(`/leads/${id}/profile`, { qualificationStatus: "in_progress" });
    assert.equal(back.body.profile.disqualifiedReason, "", "the reason goes with the status");
  });

  await t.test("names in Arabic are kept exactly", async () => {
    const c = await A.customer("971500000003", "ليلى", { text: "أبحث عن شقة في دبي مارينا" });
    const id = await A.lead(c);
    const res = await a().put(`/leads/${id}/profile`, { leadType: "buyer", communities: ["دبي مارينا", "دبي  مارينا"], notes: "تفضل الطابق العالي" });
    assert.deepEqual(res.body.profile.communities, ["دبي مارينا"], "the same name twice is kept once");
    assert.equal(res.body.profile.notes, "تفضل الطابق العالي");
    assert.equal((await A.core(A.owner).get(`/${id}`)).body.lead.contactName, "ليلى");
  });

  await t.test("a lead can be made and qualified in one step, and a mistake makes nothing", async () => {
    const dana = await A.customer("971500000004", "Dana");
    const bad = await a().post("/leads", { conversationId: dana.chat, profile: { leadType: "tenant", intent: "buy" } });
    assert.equal(bad.status, 400);
    assert.equal((await A.core(A.owner).get(`/chat/${dana.chat}`)).body.lead, null, "no lead was made");
    const good = await a().post("/leads", { conversationId: dana.chat, title: "Dana, 1 bed rental", profile: { leadType: "tenant", budgetMax: 90000, currency: "AED", bedroomsMin: 1, bedroomsMax: 1, timeline: "1_month" } });
    assert.equal(good.status, 201, JSON.stringify(good.body));
    assert.equal(good.body.profile.intent, "rent");
    assert.equal(good.body.lead.title, "Dana, 1 bed rental");
    const again = await a().post("/leads", { conversationId: dana.chat, profile: { notes: "second call" } });
    assert.equal(again.status, 200);
    assert.equal(again.body.existing, true);
    assert.equal(again.body.profile.notes, "second call", "an open lead is not duplicated");
    const tinas = await A.customer("971500000009", "Zed", { line: "tina-line" });
    assert.equal((await a(A.sam).post("/leads", { conversationId: tinas.chat })).status, 404, "a chat that is not yours is not yours to start a lead on");
    assert.equal((await A.core(A.owner).get(`/chat/${tinas.chat}`)).body.lead, null);
  });

  await t.test("staff see the qualification of their own leads only; managers see all", async () => {
    const tinaCustomer = await A.customer("971500000005", "Tariq", { line: "tina-line" });
    const tinaLead = await A.lead(tinaCustomer);
    await A.core(A.owner).patch(`/${tinaLead}`, { ownerUserId: A.tina.id });
    assert.equal((await a(A.sam).get(`/leads/${tinaLead}/profile`)).status, 404, "Sam cannot open Tina's lead");
    assert.equal((await a(A.sam).put(`/leads/${tinaLead}/profile`, { leadType: "buyer" })).status, 404);
    assert.equal((await a(A.tina).put(`/leads/${tinaLead}/profile`, { leadType: "buyer" })).status, 200);
    assert.equal((await a(A.admin).get(`/leads/${tinaLead}/profile`)).status, 200);
    assert.equal((await a(A.sam).get(`/leads/${tinaLead}/matches`)).status, 404);
    assert.equal((await a(A.sam).get(`/leads/${tinaLead}/next-actions`)).status, 404);
  });

  await t.test("another company can see none of it", async () => {
    assert.equal((await B.re(B.owner).get(`/leads/${ashaLead}/profile`)).status, 404);
    assert.equal((await B.re(B.owner).put(`/leads/${ashaLead}/profile`, { leadType: "seller" })).status, 404);
    assert.equal((await B.re(B.owner).get(`/leads/${ashaLead}/matches`)).status, 404);
    // a client that names the other company in a header gets nowhere: the session decides
    const forged = await request(app).get(`/api/solutions/real_estate/leads/${ashaLead}/profile`).set({ ...B.owner.auth, "X-Tenant-Id": A.tenantId });
    assert.equal(forged.status, 403);
    assert.equal((await a().get(`/leads/${ashaLead}/profile`)).body.profile.budgetMax, 1500000, "and the lead is untouched");
  });

  // ── Properties ──────────────────────────────────────────────────────────────────────────────────
  await t.test("only managers add properties, and a property must be valid", async () => {
    assert.equal((await a(A.sam).post("/properties", property())).status, 403);
    const post = (body) => a().post("/properties", body);
    for (const [body, pattern] of [
      [property({ reference: "bad/ref*" }), /reference is 1 to 40/],
      [property({ purpose: "swap" }), /Purpose must be one of/],
      [property({ propertyType: "castle" }), /Property type must be one of/],
      [property({ currency: "XYZ" }), /Currency must be one of/],
      [property({ price: -1 }), /more than 0/],
      [property({ listingUrl: "http://insecure.example.test/x" }), /https/],
      [property({ listingUrl: "javascript:alert(1)" }), /https/],
      [property({ media: [{ kind: "photo", url: "http://x.test/a.jpg" }] }), /https/],
      [property({ media: [{ kind: "gif", url: "https://x.test/a.gif" }] }), /Each media item is one of/],
      [property({ availableFrom: "next month" }), /2026-12-31/],
      [property({ bedrooms: 40 }), /0 to 20/],
      [property({ colour: "blue" }), /Unknown field/],
      [property({ price: null }), /add a price/],
      [property({ bedrooms: null }), /number of bedrooms/],
      [property({ purpose: "rent" }), /per year or per month/],
      [property({ community: "" }), /the community/],
    ])
      assert.match((await post(body)).body.message, pattern, JSON.stringify(body).slice(0, 80));
    assert.equal((await a().get("/properties")).body.total, 0);
  });

  await t.test("a property can be saved as a draft before everything is known", async () => {
    const res = await a().post("/properties", property({ reference: "DRAFT-1", status: undefined, price: null, bedrooms: null }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.property.status, "draft");
    assert.equal(res.body.property.verification, "never");
    assert.equal(res.body.property.lastVerifiedAt, null);
    const offer = await a().patch(`/properties/${res.body.property.id}`, { status: "available" });
    assert.equal(offer.status, 422, "it cannot be offered while it is incomplete");
    assert.deepEqual(offer.body.missing, ["a price", "the number of bedrooms"]);
  });

  const ids = {};
  await t.test("marking a property available records who said so and when; the reference is unique", async () => {
    const make = async (o) => {
      const res = await a().post("/properties", property(o));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      ids[o.reference] = res.body.property.id;
      return res.body.property;
    };
    const first = await make({ reference: "DM-101" });
    assert.equal(first.status, "available");
    assert.equal(first.verification, "fresh");
    assert.equal(first.verifiedDaysAgo, 0);
    const row = (await query("SELECT verified_by,created_by FROM re_properties WHERE id=$1", [first.id])).rows[0];
    assert.equal(row.verified_by, A.owner.id);
    assert.equal((await a().post("/properties", property({ reference: "dm-101" }))).status, 409, "references are unique whatever the capitals");
    await make({ reference: "DM-102", price: 1_650_000 });
    await make({ reference: "DM-103", price: 1_200_000, bedrooms: 3 });
    await make({ reference: "DM-104", price: 1_100_000, bedrooms: 1 });
    await make({ reference: "JVC-201", price: 900_000, community: "Jumeirah Village Circle" });
    await make({ reference: "DM-105", price: 1_300_000, propertyType: "villa" });
    await make({ reference: "DM-SOLD", price: 1_000_000, status: "sold" });
    await make({ reference: "DM-ARAB", price: 1_250_000, community: "دبي مارينا" });
    await make({ reference: "RENT-1", purpose: "rent", rentPeriod: "year", price: 110_000 });
    await make({ reference: "DM-OLD", price: 1_050_000 });
    await make({ reference: "DM-USD", price: 400_000, currency: "USD" });
    await query("UPDATE re_properties SET last_verified_at=now()-interval '40 days' WHERE id=$1", [ids["DM-OLD"]]);
    const list = (await a().get("/properties")).body;
    assert.equal(list.total, 12);
    assert.equal(list.counts.available, 10);
    assert.equal(list.counts.sold, 1);
    assert.equal(list.counts.draft, 1);
    assert.equal(list.properties.find((p) => p.reference === "DM-OLD").verification, "stale");
  });

  await t.test("properties are filtered, searched, and visible to every agent but writable only by managers and the listing agent", async () => {
    assert.equal((await a().get("/properties?status=sold")).body.total, 1);
    assert.equal((await a().get("/properties?purpose=rent")).body.properties[0].reference, "RENT-1");
    assert.equal((await a().get("/properties?q=jumeirah")).body.properties[0].reference, "JVC-201");
    assert.equal((await a(A.sam).get("/properties")).body.total, 12, "agents see the whole inventory");
    assert.equal((await a(A.sam).patch(`/properties/${ids["DM-101"]}`, { price: 1 })).status, 403);
    assert.equal((await a(A.sam).post(`/properties/${ids["DM-101"]}/verify`)).status, 403);
    const give = await a().patch(`/properties/${ids["DM-101"]}`, { agentUserId: A.sam.id });
    assert.equal(give.body.property.agentName, "Sam Agent");
    assert.equal((await a(A.sam).post(`/properties/${ids["DM-101"]}/verify`)).status, 200, "the listing agent can confirm availability");
    assert.equal((await a(A.sam).patch(`/properties/${ids["DM-101"]}`, { price: 1_450_000 })).body.property.price, 1_450_000);
    assert.equal((await a(A.sam).patch(`/properties/${ids["DM-101"]}`, { agentUserId: A.tina.id })).status, 403, "but not hand it on");
    assert.equal((await a(A.sam).patch(`/properties/${ids["DM-101"]}`, { media: [] })).status, 403, "and not change the approved media");
    assert.equal((await a().patch(`/properties/${ids["DM-101"]}`, { agentUserId: 99999999 })).status, 400);
    await a().patch(`/properties/${ids["DM-101"]}`, { price: 1_400_000 });
  });

  await t.test("approved media and the listing address are kept as given, and only https", async () => {
    const res = await a().patch(`/properties/${ids["DM-102"]}`, { media: [{ kind: "photo", url: "https://cdn.example.test/a.jpg", caption: "Living room" }, { kind: "floorplan", url: "https://cdn.example.test/p.pdf" }] });
    assert.deepEqual(res.body.property.media.map((m) => m.kind), ["photo", "floorplan"]);
    assert.equal(res.body.property.media[0].caption, "Living room");
    assert.equal(res.body.property.listingUrl, "https://listings.example.test/dm-101".replace("dm-101", "dm-101"));
  });

  await t.test("confirming availability only works on a property that is available", async () => {
    assert.equal((await a().post(`/properties/${ids["DM-SOLD"]}/verify`)).status, 409);
    await query("UPDATE re_properties SET last_verified_at=now()-interval '40 days' WHERE id=$1", [ids["DM-102"]]);
    const res = await a().post(`/properties/${ids["DM-102"]}/verify`);
    assert.equal(res.body.property.verification, "fresh");
    await query("UPDATE re_properties SET last_verified_at=now()-interval '2 days' WHERE id=$1", [ids["DM-102"]]);
  });

  // ── Matching ────────────────────────────────────────────────────────────────────────────────────
  await t.test("matching returns only listings that meet every stated requirement, and says why", async () => {
    const res = await a().get(`/leads/${ashaLead}/matches`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.eligible, true);
    const refs = res.body.matches.map((m) => m.property.reference);
    assert.deepEqual(refs, ["DM-103", "DM-101", "DM-OLD"], "recently checked first, cheapest first, then the one that needs checking");
    const m101 = res.body.matches.find((m) => m.property.reference === "DM-101");
    assert.ok(m101.reasons.includes("AED 1,400,000 is within the AED 1,500,000 budget"));
    assert.ok(m101.reasons.includes("2 bedrooms (wanted 2 to 3 bedrooms)"));
    assert.ok(m101.reasons.includes("In Dubai Marina, as wanted"));
    assert.ok(m101.reasons.includes("Type is apartment, as wanted"));
    assert.equal(m101.verification, "fresh");
    assert.match(m101.shareText, /^DM-101: 2 bed, apartment, Dubai Marina, AED 1,400,000\nhttps:\/\/listings\.example\.test\/dm-101$/);
    for (const never of ["DM-102", "DM-104", "DM-105", "JVC-201", "DM-SOLD", "RENT-1", "DRAFT-1", "DM-USD"]) assert.ok(!refs.includes(never), `${never} must not be offered`);
    const old = res.body.matches.find((m) => m.property.reference === "DM-OLD");
    assert.equal(old.verification, "stale");
    assert.match(old.warnings[0], /last checked 40 days ago: confirm it before sharing/);
    assert.equal(refs.at(-1), "DM-OLD", "stale availability comes last");
    assert.ok(res.body.leftOut.budget >= 1 && res.body.leftOut.bedrooms >= 1 && res.body.leftOut.area >= 1 && res.body.leftOut.type >= 1 && res.body.leftOut.currency >= 1);
  });

  await t.test("an area written in Arabic matches the same area written in Arabic, and nothing is translated", async () => {
    const c = await A.customer("971500000006", "Huda");
    const id = await A.lead(c);
    await a().put(`/leads/${id}/profile`, { leadType: "buyer", budgetMax: 1500000, currency: "AED", communities: ["دبي  مارينا"] });
    assert.deepEqual((await a().get(`/leads/${id}/matches`)).body.matches.map((m) => m.property.reference), ["DM-ARAB"]);
  });

  await t.test("a rental search finds rentals only, in the same currency", async () => {
    const dana = (await A.core(A.owner).get(`/chat/${(await query("SELECT id FROM conversations WHERE tenant_id=$1 AND phone='971500000004'", [A.tenantId])).rows[0].id}`)).body.lead;
    await a().put(`/leads/${dana.id}/profile`, { communities: ["Dubai Marina"] });
    const res = await a().get(`/leads/${dana.id}/matches`);
    assert.deepEqual(res.body.matches.map((m) => m.property.reference), []);
    await a().put(`/leads/${dana.id}/profile`, { bedroomsMin: 2, bedroomsMax: 2, budgetMax: 120000 });
    const two = await a().get(`/leads/${dana.id}/matches`);
    assert.deepEqual(two.body.matches.map((m) => m.property.reference), ["RENT-1"]);
    assert.ok(two.body.matches[0].reasons.includes("AED 110,000 a year is within the AED 120,000 budget"));
  });

  await t.test("it refuses to match when the lead cannot be matched, and says what to do", async () => {
    const e = await A.customer("971500000007", "Eman");
    const id = await A.lead(e);
    assert.match((await a().get(`/leads/${id}/matches`)).body.reason, /Qualify this lead first/);
    await a().put(`/leads/${id}/profile`, { leadType: "landlord" });
    assert.match((await a().get(`/leads/${id}/matches`)).body.reason, /Matching is for buyers, tenants and investors/);
    await a().put(`/leads/${id}/profile`, { leadType: "buyer" });
    assert.match((await a().get(`/leads/${id}/matches`)).body.reason, /at least one requirement/);
    assert.deepEqual((await a().get(`/leads/${id}/matches`)).body.matches, []);
  });

  await t.test("another company's listings never appear, and a company sees only its own", async () => {
    await B.re(B.owner).post("/properties", property({ reference: "DM-101", price: 100, community: "Dubai Marina" }));
    const theirs = (await B.re(B.owner).get("/properties")).body.properties;
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].reference, "DM-101", "the same reference may exist in another company");
    assert.equal((await B.re(B.owner).get(`/properties/${ids["DM-102"]}`)).status, 404);
    assert.equal((await B.re(B.owner).patch(`/properties/${ids["DM-102"]}`, { price: 1 })).status, 404);
    assert.equal((await B.re(B.owner).post(`/properties/${ids["DM-102"]}/verify`)).status, 404);
    assert.equal((await B.re(B.owner).del(`/properties/${ids["DM-102"]}`)).status, 404);
    assert.equal((await a().get(`/properties/${ids["DM-102"]}`)).body.property.price, 1_650_000);
    assert.ok(!(await a().get(`/leads/${ashaLead}/matches`)).body.matches.some((m) => m.property.price === 100));
  });

  await t.test("next steps are worked out from the lead's own records, with the reason", async () => {
    const fresh = await A.customer("971500000008", "Farah");
    const id = await A.lead(fresh);
    let actions = (await a().get(`/leads/${id}/next-actions`)).body.actions;
    assert.equal(actions[0].code, "qualify");
    await a().put(`/leads/${id}/profile`, { leadType: "buyer" });
    actions = (await a().get(`/leads/${id}/next-actions`)).body.actions;
    assert.equal(actions[0].code, "ask");
    assert.match(actions[0].text, /Ask for: budget, an area or a property type, timeline/);
    const asha = (await a().get(`/leads/${ashaLead}/next-actions`)).body.actions;
    assert.equal(asha[0].code, "offer_viewing");
    assert.match(asha[0].text, /Offer a viewing: DM-103, DM-101, DM-OLD/);
    assert.match(asha[0].why, /available listings? fits? what they asked for, and no viewing has been booked/);
    assert.ok(asha.some((x) => x.code === "follow_up"), "no follow-up is planned");
    await A.core(A.owner).post(`/${ashaLead}/tasks`, { title: "Call Asha", dueAt: new Date(Date.now() + 86400000).toISOString() });
    assert.ok(!(await a().get(`/leads/${ashaLead}/next-actions`)).body.actions.some((x) => x.code === "follow_up"));
  });

  await t.test("deleting a property is for managers, and removes only that property", async () => {
    assert.equal((await a(A.sam).del(`/properties/${ids["DM-104"]}`)).status, 403);
    assert.equal((await a().del(`/properties/${ids["DM-104"]}`)).status, 200);
    assert.equal((await a().get(`/properties/${ids["DM-104"]}`)).status, 404);
    assert.equal((await a().get(`/properties/${ids["DM-105"]}`)).status, 200);
  });
});
