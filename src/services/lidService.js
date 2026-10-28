import { withTransaction } from "../db/index.js";
import { defaultWhatsAppProvider } from "./whatsapp/WhatsAppProvider.js";
import { mobileDigits } from "./personName.js";

// WhatsApp sometimes gives a chat only a hidden "…@lid" id instead of the person's number. The phone usually knows the real
// number, so it is asked once in a while, gently, for the chats someone is looking at, and the number is kept on the chat
// (and on the person's contact when no other contact already has it). The hidden id stays as the chat's address.

let provider = defaultWhatsAppProvider;
export const setLidProvider = (fake) => {
  provider = fake || defaultWhatsAppProvider;
};
export const LID = { retryMs: 10 * 60 * 1000, perCall: 8, providerMs: 8000 };
const tried = new Map(); // chat id -> when it was last asked about
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error("WhatsApp did not answer")), ms))]);

export async function resolveLidChat(chat) {
  const digits = mobileDigits(await withTimeout(provider.resolveLidPhone(chat.tenant_id, chat.session_name, chat.provider_chat_id), LID.providerMs));
  if (!digits) return "";
  await withTransaction(async (c) => {
    await c.query("UPDATE conversations SET phone=$3 WHERE id=$1 AND tenant_id=$2 AND phone ~ '@lid$'", [chat.id, chat.tenant_id, digits]);
    if (chat.contact_id) {
      // the contact takes the real number unless the company already has a contact with it
      await c.query(
        `UPDATE contacts SET phone=$3, name=CASE WHEN name=phone THEN $3 ELSE name END,
                whatsapp_name=CASE WHEN whatsapp_name=phone THEN $3 ELSE whatsapp_name END
          WHERE id=$1 AND tenant_id=$2 AND phone ~ '@lid$'
            AND NOT EXISTS (SELECT 1 FROM contacts o WHERE o.tenant_id=$2 AND o.phone=$3)`,
        [chat.contact_id, chat.tenant_id, digits],
      );
    }
  });
  return digits;
}

// Called with rows read from `conversations`. Never waits for WhatsApp and never throws: the list does not depend on it.
export function scheduleLidResolution(rows) {
  const now = Date.now();
  const due = rows
    .filter((r) => !r.is_group && /@lid$/.test(r.phone || "") && /@lid$/.test(r.provider_chat_id || "") && now - (tried.get(r.id) || 0) > LID.retryMs)
    .slice(0, LID.perCall);
  for (const r of due) tried.set(r.id, now);
  if (!due.length) return Promise.resolve([]);
  return (async () => {
    const found = [];
    for (const chat of due) {
      try {
        if (await resolveLidChat(chat)) found.push(chat.id);
      } catch {
        /* the number is offline or slow: it is asked again later */
      }
    }
    return found;
  })().catch(() => []);
}
export const forgetLidAttempts = () => tried.clear();

