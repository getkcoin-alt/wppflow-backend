// The fields a message can contain, written {{name}}, {{first_name}} and {{company}}. Used by broadcasts and
// by automation replies, so both mean the same thing.
export const VARIABLES = ["name", "first_name", "company"];

// A contact that has no name yet is saved under its phone number: don't greet "971501234567".
const looksLikeNumber = (s) => !/\p{L}/u.test(s);

// Resolves Spintax format: {Hi|Hello|Hey} -> randomly selects one choice.
// Handles nested spintax up to 10 levels deep. Only replaces { ... } containing a pipe (|).
export function resolveSpintax(text) {
  if (!text) return "";
  let str = String(text);
  const spintaxRegex = /\{([^{}]+?\|[^{}]+?)\}/g;
  let iterations = 0;
  while (spintaxRegex.test(str) && iterations < 10) {
    str = str.replace(spintaxRegex, (_, group) => {
      const parts = group.split("|");
      return parts[Math.floor(Math.random() * parts.length)] ?? "";
    });
    iterations++;
  }
  return str;
}

export function hasSpintax(text) {
  return /\{([^{}]+?\|[^{}]+?)\}/.test(String(text || ""));
}

export function personalise(text, { name, company, spintax = true } = {}) {
  const full = String(name || "").trim();
  const known = full && !looksLikeNumber(full);
  const values = {
    name: full || "there",
    first_name: known ? full.split(/\s+/)[0] : "there",
    company: String(company || "").trim(),
  };
  let result = String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) =>
    VARIABLES.includes(key.toLowerCase()) ? values[key.toLowerCase()] : whole,
  );
  if (spintax) {
    result = resolveSpintax(result);
  }
  return result;
}

// {{fields}} the sender wrote that don't exist, so a typo is caught when saving instead of being sent.
export function unknownVariables(text) {
  const bad = new Set();
  for (const [, key] of String(text).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g))
    if (!VARIABLES.includes(key.toLowerCase())) bad.add(`{{${key}}}`);
  return [...bad];
}
