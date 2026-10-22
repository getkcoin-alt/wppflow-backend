import crypto from "node:crypto";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { query } from "../db/index.js";
import { ENV } from "../config/env.js";
import { fail } from "../middleware/http.js";
export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224 ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Allow only global unicast. Reject mapped IPv4, NAT64, link-local and documentation ranges.
  const [first, second = "0"] = ip.toLowerCase().split(":");
  const prefix = parseInt(second || "0", 16);
  return (
    isIP(ip) === 6 &&
    /^[23][0-9a-f]{0,3}:/i.test(ip) &&
    !(first === "2001" && (prefix < 0x200 || prefix === 0xdb8)) &&
    !/^2002:/i.test(ip)
  );
}
export async function resolveWebhook(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail(400, "Invalid webhook URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  )
    throw fail(400, "Use a public HTTPS webhook on port 443");
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ""), {
    all: true,
  });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw fail(400, "Private or reserved webhook destinations are forbidden");
  return { url, address: addresses[0] };
}
const secretKey = () =>
  crypto.createHash("sha256").update(ENV.JWT_SECRET).digest();
export function encryptSecret(secret) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv),
    data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex"),
  ].join(".");
}
function decryptSecret(value) {
  const [iv, tag, data] = value.split(".");
  const cipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(iv, "hex"),
  );
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(data, "hex")),
    cipher.final(),
  ]).toString();
}
export async function recordWebhook(
  tenantId,
  event,
  payload,
  client = { query },
) {
  await client.query(
    `INSERT INTO webhook_deliveries(id,tenant_id,endpoint_id,event,payload) SELECT gen_random_uuid(),tenant_id,id,$2,$3 FROM webhook_endpoints WHERE tenant_id=$1 AND enabled=true`,
    [tenantId, event, JSON.stringify(payload)],
  );
}
export async function deliverWebhook(delivery) {
  const { url, address } = await resolveWebhook(delivery.url),
    body = JSON.stringify({
      id: delivery.id,
      event: delivery.event,
      payload: delivery.payload,
    });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", decryptSecret(delivery.secret))
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        timeout: 5000,
        lookup: (host, options, callback) =>
          callback(
            null,
            options?.all ? [address] : address.address,
            address.family,
          ),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Scriwo-Id": delivery.id,
          "X-Scriwo-Timestamp": timestamp,
          "X-Scriwo-Signature": signature,
          // Original header names, kept so integrations built before the rename keep verifying.
          "X-WppFlow-Id": delivery.id,
          "X-WppFlow-Timestamp": timestamp,
          "X-WppFlow-Signature": signature,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
export async function pumpWebhooks() {
  await query(
    "UPDATE webhook_deliveries SET status='failed',error='Worker stopped during final delivery attempt' WHERE status='processing' AND attempts>=5 AND retry_at<=now()",
  );
  const { rows } =
    await query(`UPDATE webhook_deliveries d SET status='processing',attempts=attempts+1,retry_at=now()+interval '1 minute'
    FROM (SELECT id FROM webhook_deliveries WHERE status IN ('pending','retry','processing') AND retry_at<=now() AND attempts<5 ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED) q
    WHERE d.id=q.id RETURNING d.*`);
  for (const d of rows) {
    const endpoint = await query(
      "SELECT url,secret FROM webhook_endpoints WHERE id=$1 AND tenant_id=$2 AND enabled=true",
      [d.endpoint_id, d.tenant_id],
    );
    try {
      if (!endpoint.rows[0]) throw new Error("Endpoint disabled");
      const status = await deliverWebhook({ ...d, ...endpoint.rows[0] });
      if (status < 200 || status >= 300) throw new Error(`HTTP ${status}`);
      await query(
        "UPDATE webhook_deliveries SET status='delivered',response_status=$1,error=NULL WHERE id=$2",
        [status, d.id],
      );
    } catch (error) {
      await query(
        "UPDATE webhook_deliveries SET status=$1,error=$2,retry_at=now()+make_interval(secs=>$3) WHERE id=$4",
        [
          d.attempts >= 5 ? "failed" : "retry",
          error.message,
          2 ** d.attempts * 10,
          d.id,
        ],
      );
    }
  }
}
