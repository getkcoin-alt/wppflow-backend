import { query } from "../../db/index.js";
import { isForeignNumber } from "../countries.js";
import { matchesKeywords, withinHours } from "../automationRules.js";

// When does a workflow begin? Called for a customer's message in a chat the workflow is not holding yet.

// Days since anything was said in this chat before this message, by anyone but a private note. Infinity when nothing was.
export async function daysQuiet(message) {
  const { rows } = await query(
    `SELECT max(timestamp_epoch) AS last FROM messages WHERE tenant_id=$1 AND conversation_id=$2 AND id<>$3 AND type<>'internal_note'
       AND (timestamp_epoch<$4 OR (timestamp_epoch=$4 AND id<$3))`,
    [message.tenant_id, message.conversation_id, message.id, message.timestamp_epoch],
  );
  const last = rows[0]?.last;
  if (last === null || last === undefined) return Infinity;
  return Math.max(0, (Number(message.timestamp_epoch) - Number(last)) / 86400);
}

export async function workflowBegins(rule, message, conv, isFirst) {
  const c = rule.config || {};
  switch (rule.trigger_type) {
    case "first_message":
      return isFirst;
    case "returning":
      return (c.includeNew !== false && isFirst) || (await daysQuiet(message)) >= (Number(c.silentDays) || 30);
    case "foreign_number":
      return isForeignNumber(conv.phone, c.homeCodes || []) && (c.onlyNew === false || isFirst);
    case "keyword":
      return matchesKeywords(rule.trigger_condition, message.text, c.match);
    case "after_hours":
      return Boolean(c.hours) && !withinHours(c.hours, Number(message.timestamp_epoch) || Math.floor(Date.now() / 1000));
    default:
      return false;
  }
}
