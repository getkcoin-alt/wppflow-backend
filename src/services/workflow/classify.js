import { classifyChoice, unavailableReason, usageOf } from "../aiService.js";

// Understanding what a customer meant by their answer. In order, and stopping at the first that is sure:
//   1. a number: "1", "2", "option 2"            (the question spells the answers out with numbers)
//   2. the answer's own words, or the words the owner listed for it, as whole words; if two answers match it is not sure
//   3. the model, which may only pick one of the answers or say it cannot tell (and only when Riwo is available)
// Without a model, 1 and 2 still work, so a provider outage never leaves a customer without an answer.

const DIGITS = [0x0660, 0x06f0, 0x0966]; // Arabic-Indic, Persian, Devanagari
const ascii = (s) =>
  String(s ?? "").replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0);
    const base = DIGITS.find((b) => code >= b && code <= b + 9);
    return base ? String(code - base) : d;
  });
const plain = (s) =>
  ascii(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export function readNumber(node, text) {
  const m = plain(text).match(/^(?:option|number|no|answer|ans)?\s*([1-9])$/);
  return m ? node.options[Number(m[1]) - 1]?.key || null : null;
}

export function readWords(node, text) {
  const said = ` ${plain(text)} `;
  if (said.trim() === "") return null;
  const hit = node.options.filter((o) => [o.label, ...(o.hints || [])].map(plain).filter((t) => t.length >= 2).some((t) => said.includes(` ${t} `)));
  return hit.length === 1 ? hit[0].key : null;
}

// Returns { choice, via }. `choice` is an answer's key or "unsure".
export async function classifyAnswer({ tenant, node, text }) {
  const number = readNumber(node, text);
  if (number) return { choice: number, via: "number" };
  const words = readWords(node, text);
  if (words) return { choice: words, via: "words" };
  if (!plain(text)) return { choice: "unsure", via: "none" };
  // a photo, a sticker or a voice note has no words to read
  if (/^(?:📷|🎥|🎵|🎤|🖼|📎|📄)/u.test(String(text).trim()) || /^\[[^\]]+\]$/.test(String(text).trim())) return { choice: "unsure", via: "none" };
  try {
    if (!tenant || unavailableReason(tenant) || (await usageOf(tenant)).remaining <= 0) return { choice: "unsure", via: "none" };
    const out = await classifyChoice({ tenant, question: node.question, options: node.options, text });
    return { choice: out.choice, via: out.choice === "unsure" ? "none" : "ai", provider: out.provider, model: out.model };
  } catch (error) {
    console.warn(`Riwo could not read an answer: ${error.message}`);
    return { choice: "unsure", via: "none" };
  }
}
