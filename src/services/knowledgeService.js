import crypto from "node:crypto";
import { query } from "../db/index.js";
import { fail } from "../middleware/http.js";
import { assertPublicSite, crawlSite, normalizeSiteUrl } from "./websiteReader.js";
import { unavailableReason, writeKnowledgeProfile } from "./aiService.js";

// The company's knowledge base. The owner points Riwo at the company's websites (and may add notes in their own words); Riwo
// reads the pages, writes a short profile of what the company does and sells, and answers customers from it. A refresh reads
// the sites again and updates only what changed. Retrieval is by words, not by a vector database: the profile and the
// owner's notes always go in, and the pages that best match what the customer wrote go in beside them.

export const KNOWLEDGE = { maxSources: 5, maxPages: 30, maxNotes: 4000, context: 3600, refreshHours: 24 };
const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ── Sources ──────────────────────────────────────────────────────────────────────────────────────
export async function addSource(tenantId, input) {
  const url = normalizeSiteUrl(input);
  await assertPublicSite(url);
  const key = url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/$/, ""));
  const count = (await query("SELECT count(*)::int AS n FROM knowledge_sources WHERE tenant_id=$1", [tenantId])).rows[0].n;
  if (count >= KNOWLEDGE.maxSources) throw fail(400, `Riwo can read up to ${KNOWLEDGE.maxSources} websites. Remove one first.`);
  const { rows } = await query(
    `INSERT INTO knowledge_sources(tenant_id,url) VALUES($1,$2) ON CONFLICT (tenant_id,url) DO UPDATE SET status='queued',error='' RETURNING *`,
    [tenantId, key],
  );
  return rows[0];
}

export async function removeSource(tenantId, id) {
  const { rowCount } = await query("DELETE FROM knowledge_sources WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
  if (!rowCount) throw fail(404, "That website isn't in your knowledge base.");
  await rebuildProfile(tenantId).catch(() => {});
}

export async function queueRefresh(tenantId, id) {
  const { rows } = await query("UPDATE knowledge_sources SET status='queued',error='' WHERE id=$1 AND tenant_id=$2 AND status<>'reading' RETURNING *", [id, tenantId]);
  if (!rows[0]) {
    const exists = (await query("SELECT status FROM knowledge_sources WHERE id=$1 AND tenant_id=$2", [id, tenantId])).rows[0];
    if (!exists) throw fail(404, "That website isn't in your knowledge base.");
    return exists; // already being read
  }
  return rows[0];
}

// Reads one site now. Claims it first, so two servers never read the same one; safe to call for a source that is queued.
export async function readSource(sourceId) {
  const claimed = (await query("UPDATE knowledge_sources SET status='reading',last_read_at=now() WHERE id=$1 AND status IN ('queued','ready','failed') RETURNING *", [sourceId])).rows[0];
  if (!claimed) return null;
  const tenant = (await query("SELECT * FROM tenants WHERE id=$1", [claimed.tenant_id])).rows[0];
  try {
    const site = await crawlSite(claimed.url, { maxPages: KNOWLEDGE.maxPages });
    const before = new Map((await query("SELECT url,hash FROM knowledge_pages WHERE source_id=$1", [claimed.id])).rows.map((r) => [r.url, r.hash]));
    let changed = before.size === 0;
    const now = new Set();
    for (const p of site.pages) {
      now.add(p.url);
      const hash = sha(`${p.title}\n${p.description}\n${p.text}`);
      if (before.get(p.url) !== hash) changed = true;
      await query(
        `INSERT INTO knowledge_pages(tenant_id,source_id,url,title,description,text,hash) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (source_id,url) DO UPDATE SET title=$4,description=$5,text=$6,hash=$7,fetched_at=now()`,
        [claimed.tenant_id, claimed.id, p.url, p.title, p.description, p.text, hash],
      );
    }
    // pages that have gone from the site go from the knowledge base too, so Riwo never quotes what was taken down
    const gone = [...before.keys()].filter((u) => !now.has(u));
    if (gone.length) {
      changed = true;
      await query("DELETE FROM knowledge_pages WHERE source_id=$1 AND url = ANY($2::text[])", [claimed.id, gone]);
    }
    await query(
      `UPDATE knowledge_sources SET status='ready',error='',pages=$2,last_read_at=now(),last_changed_at=CASE WHEN $3::boolean THEN now() ELSE last_changed_at END WHERE id=$1`,
      [claimed.id, site.pages.length, changed],
    );
    if (changed) await rebuildProfile(claimed.tenant_id, tenant);
    return { changed, pages: site.pages.length };
  } catch (error) {
    await query("UPDATE knowledge_sources SET status='failed',error=$2,last_read_at=now() WHERE id=$1", [claimed.id, String(error.message || "Could not be read").slice(0, 300)]);
    return { failed: true };
  }
}

// ── The profile: what the company does and sells ─────────────────────────────────────────────────
const titleOf = (p) => p.title.replace(/\s*[|\-–—·].*$/, "").trim() || new URL(p.url).pathname;

export async function rebuildProfile(tenantId, tenant = null) {
  const pages = (await query("SELECT url,title,description,text FROM knowledge_pages WHERE tenant_id=$1 ORDER BY char_length(url),url LIMIT 60", [tenantId])).rows;
  const t = tenant || (await query("SELECT * FROM tenants WHERE id=$1", [tenantId])).rows[0];
  let overview = "";
  let products = [];
  let byAi = false;
  if (pages.length && t && unavailableReason(t) === null) {
    try {
      const out = await writeKnowledgeProfile({ tenant: t, pages });
      if (out) {
        overview = out.overview;
        products = out.products;
        byAi = true;
      }
    } catch (error) {
      console.warn(`Riwo could not write the knowledge profile for ${tenantId}: ${error.message}`);
    }
  }
  if (!byAi) {
    // without Riwo: the home page's own words, and the pages' titles as the list of things the company offers
    overview = pages[0] ? [pages[0].title, pages[0].description].filter(Boolean).join(". ").slice(0, 900) : "";
    products = pages.slice(1, 13).map((p) => ({ name: titleOf(p), summary: p.description.slice(0, 160), url: p.url }));
  }
  await query(
    `INSERT INTO knowledge_profile(tenant_id,overview,products,written_by_ai) VALUES($1,$2,$3,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET overview=$2,products=$3,written_by_ai=$4,updated_at=now()`,
    [tenantId, overview, JSON.stringify(products), byAi],
  );
}

export async function saveNotes(tenantId, notes) {
  const text = String(notes ?? "").replace(/<\/?[a-z_]+>/gi, "").trim();
  if (text.length > KNOWLEDGE.maxNotes) throw fail(400, `Notes can be up to ${KNOWLEDGE.maxNotes} characters.`);
  await query(
    `INSERT INTO knowledge_profile(tenant_id,notes) VALUES($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET notes=$2,updated_at=now()`,
    [tenantId, text],
  );
  return text;
}

export async function statusOf(tenantId) {
  const sources = (await query("SELECT id,url,status,error,pages,auto_refresh,last_read_at,last_changed_at,created_at FROM knowledge_sources WHERE tenant_id=$1 ORDER BY created_at", [tenantId])).rows.map((r) => ({
    id: r.id, url: r.url, status: r.status, error: r.error, pages: r.pages, autoRefresh: r.auto_refresh, lastReadAt: r.last_read_at, lastChangedAt: r.last_changed_at,
  }));
  const profile = (await query("SELECT overview,products,notes,written_by_ai,updated_at FROM knowledge_profile WHERE tenant_id=$1", [tenantId])).rows[0];
  return {
    sources,
    overview: profile?.overview || "",
    products: profile?.products || [],
    notes: profile?.notes || "",
    writtenByRiwo: profile?.written_by_ai === true,
    updatedAt: profile?.updated_at || null,
    ready: sources.some((s) => s.status === "ready") || Boolean(profile?.notes),
  };
}

// ── Retrieval ────────────────────────────────────────────────────────────────────────────────────
const STOP = new Set("the and for you your are with this that have what how can does about from need want would like please hello thanks thank tell more any our not but get who when where why which there their they them was were will just also into than then its has had been being ill im ive hi hey".split(" "));
export const wordsOf = (text) => [...new Set(String(text ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))];

// The excerpt of a page that best matches the words: a window around the densest match
function excerpt(text, words, size = 900) {
  const lower = text.toLowerCase();
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.max(1, lower.length - size / 2); i += Math.floor(size / 3)) {
    const window = lower.slice(i, i + size);
    const score = words.reduce((n, w) => n + (window.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return text.slice(best, best + size).trim();
}

// "manufacturing" and "manufacturers" are the same word for this purpose
const stemOf = (w) => {
  for (const suffix of ["ations", "ation", "ings", "ing", "ers", "er", "ies", "es", "ed", "s"]) if (w.endsWith(suffix) && w.length - suffix.length >= 4) return w.slice(0, -suffix.length);
  return w;
};

// A page is worth showing when its title or address has one of the customer's words, or its text has two different ones.
export function pickPages(pages, words, limit = 3) {
  if (!words.length) return [];
  words = words.map(stemOf);
  const starts = (text, w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(text);
  return pages
    .map((p) => {
      const title = `${p.title} ${p.url}`.toLowerCase();
      const body = p.text.toLowerCase();
      let score = 0;
      let matched = 0;
      let inTitle = false;
      for (const w of words) {
        if (starts(title, w)) {
          score += 4;
          inTitle = true;
        }
        if (starts(body, w)) {
          matched += 1;
          score += 1 + Math.min(3, Math.log2(body.split(w).length));
        }
      }
      return { p, score, ok: inTitle || matched >= 2 };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

export async function hasKnowledge(tenantId) {
  return (await statusOf(tenantId)).ready;
}

// What Riwo is given to talk to this customer: the profile (with the list of products), the owner's notes, and the pages that
// best match what the customer wrote. Returns "" when the company has no knowledge base.
export async function knowledgeFor(tenantId, customerText = "") {
  const profile = (await query("SELECT overview,products,notes FROM knowledge_profile WHERE tenant_id=$1", [tenantId])).rows[0];
  if (!profile || (!profile.overview && !profile.notes && !(profile.products || []).length)) return "";
  const parts = [];
  if (profile.overview) parts.push(`About the company:\n${profile.overview}`);
  if ((profile.products || []).length) parts.push(`What the company offers:\n${profile.products.map((p) => `- ${p.name}${p.summary ? `: ${p.summary}` : ""}${p.url ? ` (${p.url})` : ""}`).join("\n")}`);
  if (profile.notes) parts.push(`Notes from the company:\n${profile.notes}`);
  const pages = (await query("SELECT url,title,text FROM knowledge_pages WHERE tenant_id=$1", [tenantId])).rows;
  const matches = pickPages(pages, wordsOf(customerText));
  if (matches.length) parts.push(`Pages that match what the customer asked:\n${matches.map((p) => `[${p.title || p.url}] ${p.url}\n${excerpt(p.text, wordsOf(customerText))}`).join("\n\n")}`);
  return parts.join("\n\n").slice(0, KNOWLEDGE.context + 600);
}

// ── Reading in the background ────────────────────────────────────────────────────────────────────
// Queued sources are read at once; a site that has not been read for a day is read again, so a changed website changes what
// Riwo knows without anyone pressing a button. A read that was interrupted is picked up again after ten minutes.
let lastRun = 0;
const inflight = new Set();
// Reading a site can take minutes, so it never holds up the other background jobs: the reads are started and left to finish
// (`wait: true`, for tests, waits for them).
export async function pumpKnowledge({ force = false, now = Date.now(), wait = false } = {}) {
  if (!force && now - lastRun < 15_000) return 0;
  lastRun = now;
  await query("UPDATE knowledge_sources SET status='queued' WHERE status='reading' AND last_read_at < now() - interval '10 minutes'").catch(() => {});
  const due = (
    await query(
      `SELECT id FROM knowledge_sources WHERE status='queued'
          OR (status IN ('ready','failed') AND auto_refresh AND (last_read_at IS NULL OR last_read_at < now() - make_interval(hours => $1)))
        ORDER BY last_read_at NULLS FIRST LIMIT 3`,
      [KNOWLEDGE.refreshHours],
    )
  ).rows;
  const started = [];
  for (const { id } of due) {
    if (inflight.size >= 3 || [...inflight].some((x) => x.id === id)) continue;
    const job = { id, done: null };
    job.done = readSource(id)
      .catch((e) => console.error("Knowledge read failed:", e.message))
      .finally(() => inflight.delete(job));
    inflight.add(job);
    started.push(job.done);
  }
  if (wait) await Promise.all(started);
  return started.length;
}
