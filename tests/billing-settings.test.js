import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app, io } from "../src/server.js";
import { query } from "../src/db/index.js";
import { ensureSuperAdmin } from "../src/services/adminService.js";
import { registerTenantAndUser, generateAccessToken } from "../src/services/authService.js";
import { ENV } from "../src/config/env.js";
import { setMailTransport } from "../src/services/mailer.js";
import { closeSessions } from "../src/services/sessionService.js";
import { invoiceNumber, financialYearSeries, cleanSettings, billingSettings, loadBillingSettings } from "../src/services/billingSettings.js";
import { taxLines } from "../src/services/invoicePdf.js";
import { quoteFor } from "../src/services/billingService.js";

test("Invoice numbers: PREFIX/yy-yy/00001, never more than 16 characters, new series each April", () => {
  assert.equal(financialYearSeries("2026-10-25"), "26-27");
  assert.equal(financialYearSeries("2027-03-31"), "26-27", "the last day of the year");
  assert.equal(financialYearSeries("2027-04-01"), "27-28", "the first day of the next");
  assert.equal(financialYearSeries("2099-12-31"), "99-00", "a century later it still reads two and two");
  assert.equal(invoiceNumber("SCZ", "26-27", 1), "SCZ/26-27/00001");
  assert.equal(invoiceNumber("SCZ", "26-27", 99999).length, 15);
  assert.equal(invoiceNumber("SCZ", "26-27", 100000).length, 16, "a sixth digit still fits");
  assert.match(invoiceNumber("A", "26-27", 12), /^[A-Za-z0-9/-]{1,16}$/, "only letters, digits, slash and hyphen");
});

test("Tax lines on an invoice follow the rate it was made at", () => {
  const inv = (over) => ({ gst_rate: 18, cgst_minor: 0, sgst_minor: 0, igst_minor: 0, ...over });
  assert.deepEqual(taxLines(inv({ cgst_minor: 900, sgst_minor: 900 })), [["CGST @ 9%", 900], ["SGST @ 9%", 900]]);
  assert.deepEqual(taxLines(inv({ igst_minor: 1800 })), [["IGST @ 18%", 1800]]);
  assert.deepEqual(taxLines(inv({ gst_rate: 12, cgst_minor: 600, sgst_minor: 600 })), [["CGST @ 6%", 600], ["SGST @ 6%", 600]]);
  assert.deepEqual(taxLines(inv({ gst_rate: 5, cgst_minor: 250, sgst_minor: 250 })), [["CGST @ 2.5%", 250], ["SGST @ 2.5%", 250]]);
  assert.deepEqual(taxLines({ cgst_minor: 900, sgst_minor: 900 }), [["CGST @ 9%", 900], ["SGST @ 9%", 900]], "an invoice from before the rate was stored was at 18%");
});

test("Billing settings: the service code, the rate, the seller and the invoice prefix", async (t) => {
  setMailTransport({ sendMail: async () => {} });
  t.after(async () => {
    setMailTransport(undefined);
    await closeSessions(io);
    io.close();
  });
  ENV.SUPERADMIN_EMAIL = "root@settings.test";
  ENV.SUPERADMIN_PASSWORD = "SuperAdmin#12345";
  await ensureSuperAdmin();
  const sa = await request(app).post("/api/auth/login").send({ email: ENV.SUPERADMIN_EMAIL, password: ENV.SUPERADMIN_PASSWORD });
  const admin = { Authorization: `Bearer ${sa.body.token}` };
  const get = () => request(app).get("/api/admin/billing/settings").set(admin);
  const put = (body, who = admin) => request(app).put("/api/admin/billing/settings").set(who).send(body);

  let n = 0;
  const company = async (profile) => {
    n++;
    const r = await registerTenantAndUser({ name: `Owner ${n}`, email: `owner${n}@settings.test`, password: "Password@123", companyName: `Settings Co ${n}` });
    await query("UPDATE tenants SET plan='Growth' WHERE id=$1", [r.tenant.id]);
    const owner = { Authorization: `Bearer ${generateAccessToken(r.user, r.tenant.id, "owner")}` };
    assert.equal((await request(app).put("/api/billing/profile").set(owner).send(profile)).status, 200);
    return { tenantId: r.tenant.id, owner };
  };
  const UP = { legalName: "Acme Traders Pvt Ltd", addressLine1: "12 MG Road", city: "Lucknow", stateCode: "09", postalCode: "226001", billingEmail: "a@acme.test" };
  const MH = { legalName: "Beta Retail LLP", addressLine1: "5 Marine Drive", city: "Mumbai", stateCode: "27", postalCode: "400001", gstin: "27AAPFU0939F1ZV" };
  const record = (c, reference) => request(app).post(`/api/admin/companies/${c.tenantId}/subscription/payment`).set(admin).send({ plan: "growth", cycle: "monthly", amount: 8258.82, currency: "INR", reference });
  const invoiceOf = async (c) => (await query("SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY seq", [c.tenantId])).rows[0];

  await t.test("only the platform admin opens it; until someone changes it, it is the registration certificate and 18%", async () => {
    assert.equal((await request(app).get("/api/admin/billing/settings")).status, 401);
    const a = await company(UP);
    assert.equal((await request(app).get("/api/admin/billing/settings").set(a.owner)).status, 403);
    assert.equal((await put({ sacCode: "998315" }, a.owner)).status, 403);
    const s = (await get()).body.settings;
    assert.equal(s.seller.gstin, "09ABICS9865M1Z8");
    assert.equal(s.seller.legalName, "SCRIZA PRIVATE LIMITED");
    assert.equal(s.seller.stateCode, "09");
    assert.equal(s.gstRate, 18);
    assert.equal(s.invoicePrefix, "SCZ");
    assert.equal(s.prorateUpgrades, true);
    assert.match(s.nextInvoiceExample, /^SCZ\/\d{2}-\d{2}\/00001$/);
    assert.equal(s.invoiceNumberLimit, 16);
    assert.equal((await request(app).get("/api/public/plans")).body.gstRate, 18, "the price list says which rate it is quoted at");
  });

  await t.test("what is wrong with a change is said, and nothing is saved", async () => {
    const bad = async (body, pattern) => {
      const res = await put(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.message, pattern);
    };
    await bad({ sacCode: "9983" }, /six digits and starts with 99/);
    await bad({ sacCode: "123456" }, /six digits and starts with 99/);
    await bad({ gstRate: 18.5 }, /whole number from 0 to 28/);
    await bad({ gstRate: 40 }, /whole number from 0 to 28/);
    await bad({ gstRate: "eighteen" }, /whole number from 0 to 28/);
    await bad({ invoicePrefix: "SCRIZA" }, /one to three letters or digits.*16 characters/);
    await bad({ invoicePrefix: "A/B" }, /one to three letters or digits/);
    await bad({ prorateUpgrades: "yes" }, /credits the unused days/);
    await bad({ seller: { gstin: "09ABICS9865M1Z9" } }, /GSTIN is not valid/);
    await bad({ seller: { gstin: "99AAPFU0939F1ZV" } }, /GSTIN is not valid/);
    await bad({ seller: { legalName: "" } }, /Legal name is required/);
    await bad({ seller: { addressLines: [] } }, /one to three lines/);
    await bad({ seller: { addressLines: ["a", "b", "c", "d"] } }, /one to three lines/);
    await bad({ seller: { postalCode: "20130" } }, /six digits/);
    await bad({ seller: { email: "nobody" } }, /billing email is not valid/);
    const s = (await get()).body.settings;
    assert.deepEqual([s.sacCode, s.gstRate, s.invoicePrefix], ["998314", 18, "SCZ"]);
    assert.equal((await query("SELECT count(*)::int AS n FROM billing_settings_changes")).rows[0].n, 0, "refused changes leave no trace");
  });

  await t.test("an invoice made before a change keeps what it was made with; the next one uses the new settings, and the numbering carries on", async () => {
    const up = await company(UP);
    const mh = await company(MH);
    assert.equal((await record(up, "NEFT-1")).status, 201);
    const first = await invoiceOf(up);
    assert.match(first.number, /^SCZ\/\d{2}-\d{2}\/\d{5}$/);
    assert.equal(first.sac_code, "998314");
    assert.equal(Number(first.gst_rate), 18);
    assert.equal(first.seller.gstin, "09ABICS9865M1Z8");
    assert.ok(Number(first.cgst_minor) > 0 && Number(first.igst_minor) === 0, "the buyer is in the seller's state");

    const saved = await put({
      sacCode: "998315",
      gstRate: 12,
      invoicePrefix: "sz",
      prorateUpgrades: false,
      seller: { legalName: "Scriza Technologies Pvt Ltd", gstin: "27AAPFU0939F1ZV", addressLines: ["1 Bandra Kurla Complex"], city: "Mumbai", postalCode: "400051", email: "accounts@scriza.test" },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.settings.seller.stateCode, "27", "the state is the one on the GSTIN");
    assert.equal(saved.body.settings.seller.state, "Maharashtra");
    assert.equal(saved.body.settings.invoicePrefix, "SZ", "capitals");
    assert.equal(billingSettings().gstRate, 12, "in force at once");
    assert.equal((await request(app).get("/api/public/plans")).body.gstRate, 12, "and on the public price list");

    // a restart reads the same thing back
    await loadBillingSettings();
    assert.equal(billingSettings().sacCode, "998315");
    assert.equal(billingSettings().seller.legalName, "Scriza Technologies Pvt Ltd");

    assert.equal((await record(mh, "NEFT-2")).status, 201);
    const second = await invoiceOf(mh);
    assert.equal(second.number.split("/")[0], "SZ");
    assert.ok(second.number.length <= 16);
    assert.equal(Number(second.seq), Number(first.seq) + 1, "the sequence carries on across a new prefix");
    assert.equal(second.sac_code, "998315");
    assert.equal(Number(second.gst_rate), 12);
    assert.equal(second.seller.gstin, "27AAPFU0939F1ZV");
    // 8,258.82 paid, tax inside it at 12%: taxable 7,373.95 and tax 884.87, split in half because buyer and seller are both in Maharashtra
    assert.equal(Number(second.total_minor), 825882);
    assert.equal(Number(second.taxable_minor), 737395);
    assert.equal(Number(second.cgst_minor) + Number(second.sgst_minor), 88487);
    assert.equal(Number(second.igst_minor), 0);

    const again = await invoiceOf(up);
    assert.deepEqual([again.number, again.sac_code, Number(again.gst_rate), again.seller.legalName, Number(again.total_minor)], [first.number, "998314", 18, "SCRIZA PRIVATE LIMITED", Number(first.total_minor)], "an issued invoice never changes");

    // upgrades are no longer credited
    assert.equal(billingSettings().prorateUpgrades, false);
    const overview = (await request(app).get("/api/billing").set(up.owner)).body;
    assert.equal(overview.gstRate, 12);
    assert.equal(overview.prorateUpgrades, false);
  });

  await t.test("what changed, by whom and when is kept, and saving the same thing again adds nothing", async () => {
    const h = (await get()).body.history;
    assert.equal(h.length, 1);
    assert.equal(h[0].actor, "Platform Administrator");
    const said = Object.fromEntries(h[0].changes.map((c) => [c.field, [c.from, c.to]]));
    assert.deepEqual(said["Service code (SAC)"], ["998314", "998315"]);
    assert.deepEqual(said["GST rate"], ["18", "12"]);
    assert.deepEqual(said["Invoice prefix"], ["SCZ", "SZ"]);
    assert.deepEqual(said["Credit unused days on an upgrade"], ["yes", "no"]);
    assert.deepEqual(said["GSTIN"], ["09ABICS9865M1Z8", "27AAPFU0939F1ZV"]);
    const repeat = await put({ sacCode: "998315", gstRate: 12 });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.history.length, 1);
    // and a change back
    assert.equal((await put({ sacCode: "998314", gstRate: 18, invoicePrefix: "SCZ", prorateUpgrades: true, seller: { legalName: "SCRIZA PRIVATE LIMITED", gstin: "09ABICS9865M1Z8", addressLines: ["Ground Floor, 4-5, Logix Park, Captain Vijayant Thapar Marg", "Near Artech Infosystems Pvt Ltd, Sector 16"], city: "Noida, Gautambuddha Nagar", postalCode: "201301", email: "billing@scriwo.com" } })).status, 200);
    assert.equal((await get()).body.history.length, 2);
    assert.equal(billingSettings().seller.stateCode, "09");
  });

  await t.test("cleanSettings does not touch what it was not told about", () => {
    const base = billingSettings();
    const next = cleanSettings({ gstRate: 5 }, base);
    assert.equal(next.gstRate, 5);
    assert.deepEqual(next.seller, base.seller);
    assert.equal(next.sacCode, base.sacCode);
  });

  await t.test("each plan can say whether its price already includes tax, and every change to a plan is listed", async () => {
    assert.equal((await request(app).put("/api/admin/plans/growth").set(admin).send({ taxMode: "sometimes" })).status, 400);
    const before = quoteFor({ plan: "Free", period_end: null, billing_cycle: null }, { stateCode: "27" }, { plan: "growth", interval: "monthly" });
    assert.equal(before.taxMode, "exclusive");
    assert.equal(before.totalMinor, 699900 + Math.round(699900 * 0.18));
    const res = await request(app).put("/api/admin/plans/growth").set(admin).send({ taxMode: "inclusive", maxContacts: 2500, maxBroadcasts: 12, features: ["broadcasts", "automations", "leads", "ai"], prices: [{ interval: "monthly", currency: "INR", amountMinor: 749900 }, { interval: "annual", currency: "INR", amountMinor: 7499000 }, { interval: "monthly", currency: "AED", amountMinor: 79900 }, { interval: "annual", currency: "AED", amountMinor: 799000 }] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const inclusive = quoteFor({ plan: "Free", period_end: null, billing_cycle: null }, { stateCode: "27" }, { plan: "growth", interval: "monthly" });
    assert.equal(inclusive.taxMode, "inclusive");
    assert.equal(inclusive.totalMinor, 749900, "the customer pays the price shown, tax included");
    assert.equal(inclusive.taxableMinor + inclusive.taxMinor, 749900);

    const list = await request(app).get("/api/admin/plans/changes").set(admin);
    assert.equal(list.status, 200);
    const latest = list.body.changes[0];
    assert.equal(latest.plan, "growth");
    assert.equal(latest.actor, "Platform Administrator");
    const said = Object.fromEntries(latest.changes.map((c) => [c.field, [c.from, c.to]]));
    assert.deepEqual(said["Tax"], ["exclusive", "inclusive"]);
    assert.deepEqual(said["Contacts"], ["no limit", "2500"]);
    assert.deepEqual(said["Broadcasts a month"], ["no limit", "12"]);
    assert.deepEqual(said["Audit log"], ["included", "not included"]);
    assert.equal(said["Price, INR monthly"][1], "INR 7,499 a month");
    assert.equal(said["Price, INR monthly"][0], "INR 6,999 a month");
    assert.equal(said["Price, AED monthly"], undefined, "a price that did not change is not listed");
    assert.equal((await request(app).get("/api/admin/plans/changes").set({ Authorization: "Bearer nope" })).status, 401);
    // put it back for the tests that follow
    await request(app).put("/api/admin/plans/growth").set(admin).send({ taxMode: "exclusive", maxContacts: null, maxBroadcasts: null, features: ["broadcasts", "automations", "leads", "audit", "ai"], prices: [{ interval: "monthly", currency: "INR", amountMinor: 699900 }, { interval: "annual", currency: "INR", amountMinor: 6999000 }, { interval: "monthly", currency: "AED", amountMinor: 79900 }, { interval: "annual", currency: "AED", amountMinor: 799000 }] });
  });
});
