import { recordWebhook } from "../webhookService.js";
import { maskPhone } from "./templates.js";

// What a company's OTP webhook is told. The code itself is never in it. The phone number is, in full, because the company's own
// system needs to know which of its users the event is about; it goes only to the address the company registered, signed.
export async function emitOtpEvent(tenantId, event, request, extra = {}) {
  try {
    await recordWebhook(tenantId, event, {
      id: request.id,
      phone: `+${request.phone}`,
      phoneMasked: maskPhone(request.phone),
      reference: request.reference ?? null,
      template: request.template_key,
      mode: request.mode,
      source: request.source,
      ...extra,
    });
  } catch (error) {
    // the code must still be sent, and checked, if telling the company's server fails
    console.error("OTP webhook:", error.message);
  }
}
