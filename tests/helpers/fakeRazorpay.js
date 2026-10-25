import http from "node:http";
import crypto from "node:crypto";

// A stand-in for Razorpay's API for tests: orders, payments, plans and subscriptions held in memory, with the same
// shapes and the same Basic authentication. Nothing here is the real service, so a pass proves our side only.
export async function startFakeRazorpay({ keyId = "rzp_test_fakekey", keySecret = "fake_key_secret" } = {}) {
  const state = { orders: new Map(), payments: new Map(), plans: new Map(), subscriptions: new Map(), calls: [], failNext: null, hold: false };
  const id = (prefix) => `${prefix}_${crypto.randomBytes(7).toString("hex")}`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    state.calls.push({ method: req.method, path: req.url, body });
    const auth = req.headers.authorization || "";
    if (auth !== `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`) return send(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } });
    if (state.failNext) {
      const f = state.failNext;
      state.failNext = null;
      return send(f.status, { error: { code: "SERVER_ERROR", description: f.message } });
    }
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean); // v1, orders, id, payments
    if (req.method === "POST" && url.pathname === "/v1/orders") {
      const order = { id: id("order"), entity: "order", amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes || {}, status: "created" };
      state.orders.set(order.id, order);
      return send(200, order);
    }
    if (req.method === "GET" && parts[1] === "orders" && parts[3] === "payments") return send(200, { items: [...state.payments.values()].filter((p) => p.order_id === parts[2]) });
    if (req.method === "GET" && parts[1] === "payments" && parts[2] && !parts[3]) {
      const p = state.payments.get(parts[2]);
      return p ? send(200, p) : send(404, { error: { description: "No payment found" } });
    }
    if (req.method === "POST" && parts[1] === "payments" && parts[3] === "capture") {
      const p = state.payments.get(parts[2]);
      if (!p) return send(404, { error: { description: "No payment found" } });
      p.status = "captured";
      return send(200, p);
    }
    if (req.method === "POST" && url.pathname === "/v1/plans") {
      const plan = { id: id("plan"), ...body };
      state.plans.set(plan.id, plan);
      return send(200, plan);
    }
    if (req.method === "POST" && url.pathname === "/v1/subscriptions") {
      const sub = { id: id("sub"), status: "created", paid_count: 0, ...body };
      state.subscriptions.set(sub.id, sub);
      return send(200, sub);
    }
    if (req.method === "POST" && parts[1] === "subscriptions" && parts[3] === "cancel") {
      const sub = state.subscriptions.get(parts[2]);
      if (!sub) return send(404, { error: { description: "No subscription found" } });
      sub.status = "cancelled";
      return send(200, sub);
    }
    return send(404, { error: { description: "Not found" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    keyId,
    keySecret,
    state,
    // a customer pays an order at the checkout
    pay(orderId, over = {}) {
      const order = state.orders.get(orderId);
      const payment = { id: id("pay"), entity: "payment", amount: order.amount, currency: order.currency, status: "captured", order_id: orderId, method: "upi", notes: {}, ...over };
      state.payments.set(payment.id, payment);
      return payment;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
