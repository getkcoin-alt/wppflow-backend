import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, sameName, amountsIn, money } from "../src/solutions/real-estate/text.js";
import { zonedToUtc, localDateTime, humanDateTime, isZone } from "../src/solutions/real-estate/time.js";
import { matchProperties, evaluate, matchability } from "../src/solutions/real-estate/matching.js";

test("Names are compared without regard to case, spacing, punctuation, accents or the form of the Arabic alef", () => {
  assert.equal(normalizeText("  Dubai   MARINA "), "dubai marina");
  assert.equal(normalizeText("Dubai-Marina,"), "dubai marina");
  assert.equal(normalizeText("Café Étoile"), "cafe etoile");
  assert.ok(sameName("دبي مارينا", "دبي  مارينا"), "Arabic with extra spaces");
  assert.ok(sameName("أبوظبي", "ابوظبي"), "alef with hamza and bare alef");
  assert.ok(sameName("الـمرسى", "المرسى"), "the stretching mark is ignored");
  assert.ok(sameName("दुबई मरीना", "दुबई  मरीना"), "Devanagari survives, vowel signs and all");
  assert.notEqual(normalizeText("दुबई"), normalizeText("दबई"), "a vowel sign is not thrown away");
  assert.ok(!sameName("Marina", "Dubai Marina"), "a part of a name is a different place");
  assert.ok(!sameName("Dubai Marina", "دبي مارينا"), "nothing is translated or guessed");
  assert.ok(!sameName("", ""), "nothing is the same as nothing");
});

test("Amounts a customer wrote are found, including shorthand", () => {
  assert.deepEqual(amountsIn("my budget is 1.5M"), [1500000]);
  assert.deepEqual(amountsIn("around 850k or 1,200,000"), [850000, 1200000]);
  assert.deepEqual(amountsIn("1.2 million"), [1200000]);
  assert.deepEqual(amountsIn("ميزانيتي 2 مليون"), [2000000]);
  assert.deepEqual(amountsIn("no numbers here"), []);
  assert.equal(money(1450000, "AED"), "AED 1,450,000");
  assert.equal(money(85000.5, "AED"), "AED 85,000.5");
});

test("Local times become exact moments, correctly across zones and clock changes", () => {
  // Dubai has no daylight saving: 16:00 is 12:00 UTC all year
  assert.equal(zonedToUtc({ date: "2026-11-03", time: "16:00", zone: "Asia/Dubai" }).toISOString(), "2026-11-03T12:00:00.000Z");
  assert.equal(zonedToUtc({ date: "2026-07-03", time: "16:00", zone: "Asia/Dubai" }).toISOString(), "2026-07-03T12:00:00.000Z");
  assert.equal(zonedToUtc({ date: "2026-11-03", time: "16:00", zone: "Asia/Kolkata" }).toISOString(), "2026-11-03T10:30:00.000Z");
  // London: winter is UTC, summer is UTC+1
  assert.equal(zonedToUtc({ date: "2026-01-15", time: "09:00", zone: "Europe/London" }).toISOString(), "2026-01-15T09:00:00.000Z");
  assert.equal(zonedToUtc({ date: "2026-07-15", time: "09:00", zone: "Europe/London" }).toISOString(), "2026-07-15T08:00:00.000Z");
  // the hour that does not exist when clocks go forward (29 March 2026, 01:00 -> 02:00) is refused
  assert.equal(zonedToUtc({ date: "2026-03-29", time: "01:30", zone: "Europe/London" }), null);
  assert.equal(zonedToUtc({ date: "2026-03-29", time: "02:30", zone: "Europe/London" }).toISOString(), "2026-03-29T01:30:00.000Z");
  // the hour that happens twice when clocks go back (25 October 2026): the first one
  assert.equal(zonedToUtc({ date: "2026-10-25", time: "01:30", zone: "Europe/London" }).toISOString(), "2026-10-25T00:30:00.000Z");
  // bad input
  for (const bad of [["2026-02-30", "10:00"], ["2026-13-01", "10:00"], ["2026-11-03", "25:00"], ["2026-11-03", "9:00"], ["tomorrow", "10:00"]])
    assert.equal(zonedToUtc({ date: bad[0], time: bad[1], zone: "Asia/Dubai" }), null, bad.join(" "));
  // and back
  const at = Date.parse("2026-11-03T12:00:00Z");
  assert.deepEqual(localDateTime(at, "Asia/Dubai"), { date: "2026-11-03", time: "16:00" });
  assert.deepEqual(localDateTime(at, "Asia/Kolkata"), { date: "2026-11-03", time: "17:30" });
  assert.deepEqual(localDateTime(Date.parse("2026-11-03T21:00:00Z"), "Asia/Dubai"), { date: "2026-11-04", time: "01:00" }, "a new day in Dubai");
  assert.equal(humanDateTime(at, "Asia/Dubai"), "Tue 3 Nov 2026, 16:00");
  assert.ok(isZone("Asia/Dubai") && !isZone("Mars/Olympus") && !isZone("") && !isZone(null));
});

const NOW = Date.parse("2026-11-01T10:00:00Z");
const prop = (o) => ({ id: o.reference, status: "available", purpose: "sale", price: 1_400_000, currency: "AED", rentPeriod: null, community: "Dubai Marina", propertyType: "apartment", bedrooms: 2, availableFrom: null, lastVerifiedAt: "2026-10-30T10:00:00Z", ...o });
const buyer = (o = {}) => ({ leadType: "buyer", intent: "buy", budgetMin: null, budgetMax: 1_500_000, currency: "AED", communities: ["Dubai Marina"], propertyTypes: ["apartment"], bedroomsMin: 2, bedroomsMax: 3, timeline: "3_months", ...o });
const run = (profile, props, o = {}) => matchProperties(profile, props, { now: NOW, ...o });

test("Matching: a property must meet every stated requirement, and says why", () => {
  const r = run(buyer(), [prop({ reference: "DM-1" })]);
  assert.equal(r.eligible, true);
  assert.equal(r.matches.length, 1);
  assert.deepEqual(r.matches[0].reasons, [
    "For sale",
    "AED 1,400,000 is within the AED 1,500,000 budget",
    "2 bedrooms (wanted 2 to 3 bedrooms)",
    "Type is apartment, as wanted",
    "In Dubai Marina, as wanted",
    "Availability checked 2 days ago",
  ]);
  assert.deepEqual(r.matches[0].warnings, []);
  assert.equal(r.matches[0].verification, "fresh");
});

test("Matching: each requirement excludes, and the result says what left listings out", () => {
  const props = [
    prop({ reference: "OK" }),
    prop({ reference: "PRICEY", price: 1_500_001 }),
    prop({ reference: "EDGE", price: 1_500_000 }),
    prop({ reference: "ONEBED", bedrooms: 1 }),
    prop({ reference: "FOURBED", bedrooms: 4 }),
    prop({ reference: "UNKNOWNBED", bedrooms: null }),
    prop({ reference: "VILLA", propertyType: "villa" }),
    prop({ reference: "JVC", community: "Jumeirah Village Circle" }),
    prop({ reference: "USD", currency: "USD" }),
    prop({ reference: "SOLD", status: "sold" }),
    prop({ reference: "DRAFT", status: "draft" }),
    prop({ reference: "RESERVED", status: "reserved" }),
    prop({ reference: "RENTAL", purpose: "rent", rentPeriod: "year" }),
    prop({ reference: "NOPRICE", price: null }),
  ];
  const r = run(buyer(), props);
  assert.deepEqual(r.matches.map((m) => m.property.reference).sort(), ["EDGE", "OK"], "the budget is a limit that includes itself");
  assert.deepEqual(r.leftOut, { budget: 1, bedrooms: 3, type: 1, area: 1, currency: 1 });
  assert.equal(r.candidates, 2 + 1 + 3 + 1 + 1 + 1, "sold, draft, reserved, rental and priceless listings were never candidates");
});

test("Matching: ranking is by how recently availability was checked, then price, then reference", () => {
  const r = run(buyer({ bedroomsMin: null, bedroomsMax: null }), [
    prop({ reference: "B-10", price: 1_000_000, lastVerifiedAt: "2026-10-30T00:00:00Z" }),
    prop({ reference: "A-2", price: 1_100_000, lastVerifiedAt: "2026-10-31T00:00:00Z" }),
    prop({ reference: "A-10", price: 1_100_000, lastVerifiedAt: "2026-10-31T00:00:00Z" }),
    prop({ reference: "OLD", price: 900_000, lastVerifiedAt: "2026-08-01T00:00:00Z" }),
    prop({ reference: "NEVER", price: 800_000, lastVerifiedAt: null }),
  ]);
  assert.deepEqual(r.matches.map((m) => m.property.reference), ["B-10", "A-2", "A-10", "OLD", "NEVER"], "fresh by price then natural reference order, then stale, then never checked");
  assert.deepEqual(r.matches.map((m) => m.verification), ["fresh", "fresh", "fresh", "stale", "never"]);
  assert.match(r.matches[3].warnings[0], /last checked 92 days ago: confirm it before sharing/);
  assert.match(r.matches[4].warnings[0], /never been checked/);
  assert.equal(run(buyer({ bedroomsMin: null, bedroomsMax: null }), r.matches.map((m) => m.property), { freshnessDays: 120 }).matches.find((m) => m.property.reference === "OLD").verification, "fresh", "the company's own freshness limit applies");
});

test("Matching: area names are compared as names, in any script", () => {
  const props = [prop({ reference: "AR", community: "دبي  مارينا" }), prop({ reference: "EN", community: "dubai-marina" }), prop({ reference: "PART", community: "Marina Gate" })];
  assert.deepEqual(run(buyer({ communities: ["Dubai Marina", "دبي مارينا"] }), props).matches.map((m) => m.property.reference).sort(), ["AR", "EN"]);
});

test("Matching: rentals, minimum budget, timeline and refusing a search that would match everything", () => {
  const tenant = { leadType: "tenant", intent: "rent", budgetMin: 80_000, budgetMax: 120_000, currency: "AED", communities: [], propertyTypes: [], bedroomsMin: 1, bedroomsMax: 1, timeline: "immediate" };
  const rental = (o) => prop({ purpose: "rent", rentPeriod: "year", bedrooms: 1, price: 100_000, ...o });
  const r = run(tenant, [rental({ reference: "R1" }), rental({ reference: "CHEAP", price: 60_000 }), rental({ reference: "LATER", availableFrom: "2027-03-01" }), prop({ reference: "SALE" })]);
  assert.deepEqual(r.matches.map((m) => m.property.reference).sort(), ["CHEAP", "LATER", "R1"]);
  assert.ok(r.matches.find((m) => m.property.reference === "R1").reasons.includes("AED 100,000 a year is within the AED 120,000 budget"));
  assert.match(r.matches.find((m) => m.property.reference === "CHEAP").warnings[0], /Below the AED 80,000/);
  assert.match(r.matches.find((m) => m.property.reference === "LATER").warnings[0], /Available from 2027-03-01, later than the prospect's timeline/);

  assert.equal(matchability(null).ok, false);
  assert.match(matchability({ ...tenant, leadType: "landlord" }).reason, /Matching is for buyers, tenants and investors/);
  assert.match(matchability({ ...tenant, intent: null }).reason, /buy or to rent/);
  assert.match(matchability({ ...tenant, budgetMin: null, budgetMax: null, bedroomsMin: null, bedroomsMax: null }).reason, /at least one requirement/);
  assert.equal(run({ ...tenant, budgetMax: null, bedroomsMin: null, bedroomsMax: null, budgetMin: null, communities: [] }, [rental({ reference: "R1" })]).eligible, false);
  assert.equal(matchability({ ...tenant, currency: null }).ok, false, "a budget needs a currency");
  assert.deepEqual(evaluate(buyer(), prop({ reference: "X", status: "sold" })), { ok: false, code: "status", message: "Not available (sold)" });
});
