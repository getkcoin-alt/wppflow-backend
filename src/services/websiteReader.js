import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fail } from "../middleware/http.js";
import { publicAddress } from "./webhookService.js";

// Reads a company's own public website so Riwo can write the "about" text from it. The address is typed by a customer, so it
// is treated as hostile: only http(s) on the usual ports, never an address on a private network (checked on every redirect,
// and the connection is pinned to the address that was checked), a short time, a small size, and text pages only.

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const MAX_PAGES = 4; // the home page and up to three pages that tell about the business
const PAGE_TEXT = 5000;

// ── The address ──────────────────────────────────────────────────────────────────────────────────
export function normalizeSiteUrl(input) {
  let raw = String(input ?? "").trim();
  if (!raw) throw fail(400, "Enter your website address");
  if (raw.length > 200) throw fail(400, "That address is too long");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail(400, "That doesn't look like a website address");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw fail(400, "Use a website address that starts with http or https");
  if (url.username || url.password) throw fail(400, "Leave out any user name or password");
  if (url.port && !["80", "443"].includes(url.port)) throw fail(400, "Use your website's normal address, without a port number");
  if (!url.hostname.includes(".") && !isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw fail(400, "That doesn't look like a website address");
  url.hash = "";
  return url;
}

// ── The network, replaceable in tests ────────────────────────────────────────────────────────────
function realGet(url, address) {
  const lib = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "GET",
        timeout: TIMEOUT_MS,
        headers: { "user-agent": "ScriwoBot/1.0 (+https://www.scriwo.com)", accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "accept-encoding": "identity" },
        // the connection goes to the address that passed the check, whatever the name resolves to a moment later
        lookup: (host, options, callback) => (options?.all ? callback(null, [{ address: address.address, family: address.family }]) : callback(null, address.address, address.family)),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("TOO_BIG"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location || "", type: String(res.headers["content-type"] || ""), body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
    req.end();
  });
}
const real = { resolve: (host) => lookup(host, { all: true }), get: realGet };
let io = real;
export const setWebsiteIO = (replacement) => {
  io = replacement ? { ...real, ...replacement } : real;
};

async function publicTarget(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await io.resolve(host);
  } catch {
    throw fail(422, "We couldn't find that website. Check the address.");
  }
  if (!addresses?.length || addresses.some((a) => !publicAddress(a.address))) throw fail(400, "That address isn't a public website.");
  return addresses[0];
}

// One page, following a few redirects, each checked like the first address.
export async function fetchPage(start) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await publicTarget(url);
    let res;
    try {
      res = await io.get(url, address);
    } catch (error) {
      throw fail(422, error?.message === "TOO_BIG" ? "That page is too big to read." : "We couldn't open that website. It may be down, or it may block automatic readers.");
    }
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      try {
        url = new URL(res.location, url);
      } catch {
        throw fail(422, "That website sent us somewhere we couldn't follow.");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw fail(400, "That website sent us somewhere we can't follow.");
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw fail(422, `That website answered with an error (${res.status}).`);
    if (!/text\/html|text\/plain|application\/xhtml/i.test(res.type)) throw fail(422, "That address isn't a web page.");
    return { url, html: res.body };
  }
  throw fail(422, "That website redirects too many times.");
}

// ── The text ─────────────────────────────────────────────────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-", hellip: "..." };
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (m, n) => (Number(n) > 31 && Number(n) < 0x10ffff ? String.fromCodePoint(Number(n)) : " "))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => (parseInt(n, 16) > 31 && parseInt(n, 16) < 0x10ffff ? String.fromCodePoint(parseInt(n, 16)) : " "))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
const meta = (html, name) => {
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i"))?.[0];
  return decode(tag?.match(/content=["']([^"']*)["']/i)?.[1] || "").replace(/\s+/g, " ").trim();
};

export function extractPage(html, base) {
  const source = String(html ?? "");
  const title = decode(source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const description = (meta(source, "description") || meta(source, "og:description")).slice(0, 400);
  const links = [];
  for (const m of source.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
    try {
      links.push(new URL(decode(m[1]), base));
    } catch {
      /* not a link we can use */
    }
  }
  const body = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|ul|ol|h[1-6]|tr|header|footer|nav|br|main|blockquote)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const seen = new Set();
  const lines = decode(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 3 && !seen.has(l.toLowerCase()) && seen.add(l.toLowerCase()));
  return { title, description, text: lines.join("\n").slice(0, PAGE_TEXT), links };
}

const ABOUT_PATH = /\/(about|about-us|who-we-are|our-story|company|services?|solutions?|products?|what-we-do|offerings?|contact|contact-us|faq|faqs)(\/|$|\.html?$)/i;
const hostKey = (u) => u.hostname.toLowerCase().replace(/^www\./, "");

// The home page and the pages most likely to say what the business does.
export async function readWebsite(input) {
  const start = normalizeSiteUrl(input);
  const home = await fetchPage(start);
  const first = extractPage(home.html, home.url);
  const pages = [{ url: home.url.href, title: first.title, description: first.description, text: first.text }];
  const wanted = [];
  for (const link of first.links) {
    if (hostKey(link) !== hostKey(home.url) || !["http:", "https:"].includes(link.protocol)) continue;
    link.hash = "";
    link.search = "";
    if (link.href === home.url.href || !ABOUT_PATH.test(link.pathname) || /\.(pdf|jpe?g|png|gif|webp|zip|docx?|xlsx?)$/i.test(link.pathname)) continue;
    if (!wanted.some((w) => w.href === link.href)) wanted.push(link);
  }
  for (const link of wanted.slice(0, MAX_PAGES - 1)) {
    try {
      const page = await fetchPage(link);
      const got = extractPage(page.html, page.url);
      if (got.text.length > 80) pages.push({ url: page.url.href, title: got.title, description: got.description, text: got.text });
    } catch {
      /* a page that cannot be read is skipped; the home page is enough */
    }
  }
  if (!pages.some((p) => p.text.length > 80 || p.description.length > 40))
    throw fail(422, "We couldn't find any text on that website. Sites that only show their words after loading scripts can't be read; write a few sentences yourself instead.");
  return { url: home.url.origin, pages };
}
