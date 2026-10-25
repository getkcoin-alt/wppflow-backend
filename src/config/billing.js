// Who sells, and how online payment is configured. The keys and the webhook secret live only in the server's
// environment file, never in the repository or the browser. They are read when needed, so a restart is the only
// thing a change takes.

// From the GST registration certificate (GSTIN 09ABICS9865M1Z8). The accountant confirms the invoice fields and
// the service code before the first live invoice; the service code can be changed with SELLER_SAC_CODE.
export const SELLER = {
  legalName: "SCRIZA PRIVATE LIMITED",
  tradeName: "Scriwo",
  gstin: "09ABICS9865M1Z8",
  addressLines: ["Ground Floor, 4-5, Logix Park, Captain Vijayant Thapar Marg", "Near Artech Infosystems Pvt Ltd, Sector 16"],
  city: "Noida, Gautambuddha Nagar",
  state: "Uttar Pradesh",
  stateCode: "09",
  postalCode: "201301",
  country: "India",
  email: "billing@scriwo.com",
};
export const sacCode = () => process.env.SELLER_SAC_CODE || "998314";
export const GST_RATE = 18;

// Credit the unused days of the current plan against an upgrade (on by default). BILLING_PRORATE_UPGRADES=false
// makes an upgrade a plain purchase of the new plan.
export const prorateUpgrades = () => process.env.BILLING_PRORATE_UPGRADES !== "false";

export function razorpayConfig() {
  const keyId = (process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || "").trim();
  const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  return {
    keyId,
    keySecret,
    webhookSecret,
    // Online payment is off unless all three are present.
    configured: Boolean(keyId && keySecret && webhookSecret),
    mode: keyId.startsWith("rzp_live_") ? "live" : keyId.startsWith("rzp_test_") ? "test" : null,
    apiBase: (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com").replace(/\/+$/, ""),
  };
}
