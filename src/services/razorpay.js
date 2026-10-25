import crypto from "node:crypto";
import { razorpayConfig } from "../config/billing.js";

// The one place that talks to Razorpay. Signatures are checked here, in constant time, with the secret that
// belongs to each kind of message: the API key secret for what the checkout returns to the browser, and the
// separate webhook secret for what Razorpay posts to the server.
const hmac = (secret, data) => crypto.createHmac("sha256", secret).update(data).digest("hex");
function sameHex(a, b) {
  const x = Buffer.from(String(a || ""), "utf8"),
    y = Buffer.from(String(b || ""), "utf8");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
// What the checkout returns after a payment for an order: HMAC-SHA256(order_id + "|" + payment_id), keyed with
// the API key secret. The order id used must be the one on our own record, never the browser's.
export const checkoutSignature = (orderId, paymentId, secret = razorpayConfig().keySecret) => hmac(secret, `${orderId}|${paymentId}`);
export const verifyCheckoutSignature = (orderId, paymentId, signature, secret = razorpayConfig().keySecret) =>
  Boolean(secret) && sameHex(checkoutSignature(orderId, paymentId, secret), signature);
// For a subscription the checkout signs payment id first: HMAC-SHA256(payment_id + "|" + subscription_id).
export const subscriptionSignature = (paymentId, subscriptionId, secret = razorpayConfig().keySecret) => hmac(secret, `${paymentId}|${subscriptionId}`);
export const verifySubscriptionSignature = (paymentId, subscriptionId, signature, secret = razorpayConfig().keySecret) =>
  Boolean(secret) && sameHex(subscriptionSignature(paymentId, subscriptionId, secret), signature);
// A webhook is signed over the exact bytes received, with the webhook secret.
export const webhookSignature = (rawBody, secret) => hmac(secret, rawBody);
export const verifyWebhookSignature = (rawBody, signature, secret = razorpayConfig().webhookSecret) =>
  Boolean(secret) && sameHex(webhookSignature(rawBody, secret), signature);

export class GatewayError extends Error {
  constructor(message, { status = 502, code = "", retryable = true } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function call(method, path, body) {
  const cfg = razorpayConfig();
  if (!cfg.configured) throw new GatewayError("Online payment is not switched on", { status: 503, retryable: false });
  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${cfg.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Razorpay's reason is kept for the logs; the key is never part of it
      const reason = data?.error?.description || `HTTP ${res.status}`;
      throw new GatewayError(reason, { status: res.status >= 500 ? 502 : 400, code: data?.error?.code || "", retryable: res.status >= 500 });
    }
    return data;
  } catch (e) {
    if (e instanceof GatewayError) throw e;
    throw new GatewayError(e.name === "AbortError" ? "The payment service did not answer in time" : "Could not reach the payment service");
  } finally {
    clearTimeout(timer);
  }
}

export const createOrder = ({ amount, currency, receipt, notes }) => call("POST", "/v1/orders", { amount, currency, receipt, notes });
export const fetchPayment = (id) => call("GET", `/v1/payments/${encodeURIComponent(id)}`);
export const capturePayment = (id, amount, currency) => call("POST", `/v1/payments/${encodeURIComponent(id)}/capture`, { amount, currency });
export const fetchOrderPayments = async (orderId) => (await call("GET", `/v1/orders/${encodeURIComponent(orderId)}/payments`)).items || [];
export const createPlan = ({ period, name, amount, currency, notes }) =>
  call("POST", "/v1/plans", { period, interval: 1, item: { name, amount, currency }, notes });
export const createSubscription = (body) => call("POST", "/v1/subscriptions", body);
export const fetchSubscription = (id) => call("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
export const cancelSubscription = (id, atCycleEnd = true) =>
  call("POST", `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
