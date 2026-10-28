// The SQL condition both the chat list and the inbox search use to find a person by name or number.

export const likeOf = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const digitsOf = (text) => String(text ?? "").replace(/\D/g, "");

// SQL condition for "this chat is with a person who matches", for a query added to `params` at the returned positions.
// A hidden "…@lid" id is not a number and is never matched as one.
export function chatMatch(params, text, alias = "conversations") {
  params.push(likeOf(text));
  const like = `$${params.length}`;
  // a name that is only WhatsApp's id for the person ("…@lid") is not a name, and is not searched
  const named = (col) => `(${col} !~ '@(lid|c\\.us|g\\.us|s\\.whatsapp\\.net)$' AND ${col} ILIKE ${like} ESCAPE '\\')`;
  let sql = `${named(`${alias}.contact_name`)} OR (${alias}.phone !~ '@lid$' AND ${alias}.phone ILIKE ${like} ESCAPE '\\')
    OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.id=${alias}.contact_id AND ct.tenant_id=${alias}.tenant_id AND (${named("ct.name")} OR ${named("ct.whatsapp_name")}))`;
  const digits = digitsOf(text);
  // a number written with spaces, dashes or a plus still finds the chat; and 0-prefixed local numbers match their tail
  if (digits.length >= 3 && /^[\s\d+().-]+$/.test(text)) {
    params.push(`%${digits.replace(/^0+/, "") || digits}%`);
    sql += ` OR (${alias}.phone !~ '@(lid|g\\.us)$' AND regexp_replace(${alias}.phone,'\\D','','g') LIKE $${params.length})`;
  }
  return `(${sql})`;
}

