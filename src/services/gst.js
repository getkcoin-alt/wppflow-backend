import { fail } from "../middleware/http.js";
import { GST_RATE, SELLER } from "../config/billing.js";

// GST state codes, as printed on a GSTIN's first two digits.
export const STATES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland",
  "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
  "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};
export const stateList = () => Object.entries(STATES).map(([code, name]) => ({ code, name }));

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
// A GSTIN is 15 characters: state, PAN, entity number, Z, and a check character.
export function validGstin(value) {
  const g = String(value || "").toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  if (!STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === g[14];
}

// The tax on an amount, in paise. Rates apply to the taxable value; inside the seller's state the tax is split
// between the centre and the state (CGST and SGST), elsewhere it is IGST. The parts always add up to the whole.
export function computeTax({ amountMinor, taxMode = "exclusive", intraState, rate = GST_RATE }) {
  const given = Math.round(Number(amountMinor));
  if (!Number.isFinite(given) || given < 0) throw fail(400, "The amount is not valid");
  let taxable = given,
    total,
    tax;
  if (taxMode === "inclusive") {
    taxable = Math.round((given * 100) / (100 + rate));
    total = given;
    tax = total - taxable;
  } else {
    tax = Math.round((taxable * rate) / 100);
    total = taxable + tax;
  }
  const cgst = intraState ? Math.round(tax / 2) : 0;
  const sgst = intraState ? tax - cgst : 0;
  const igst = intraState ? 0 : tax;
  return { taxable, tax, total, cgst, sgst, igst, rate };
}
export const isIntraState = (buyerStateCode) => String(buyerStateCode) === SELLER.stateCode;

// What the buyer's details have to be before an invoice can be made.
export function cleanProfile(input = {}) {
  const text = (v, label, max, required = true) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    if (!s && required) throw fail(400, `${label} is required`);
    if (s.length > max) throw fail(400, `${label} can be up to ${max} characters`);
    return s;
  };
  const stateCode = String(input.stateCode ?? "").padStart(2, "0");
  if (!STATES[stateCode]) throw fail(400, "Choose the state your company is in");
  const postalCode = text(input.postalCode, "PIN code", 10);
  if (!/^[1-9][0-9]{5}$/.test(postalCode)) throw fail(400, "Enter a 6 digit PIN code");
  let gstin = String(input.gstin ?? "").replace(/\s+/g, "").toUpperCase();
  if (gstin) {
    if (!validGstin(gstin)) throw fail(400, "That GSTIN is not valid. Check the 15 characters, or leave it blank if the company has none.");
    if (gstin.slice(0, 2) !== stateCode) throw fail(400, `The GSTIN starts with ${gstin.slice(0, 2)} (${STATES[gstin.slice(0, 2)]}), so choose that state`);
  } else gstin = null;
  const email = text(input.billingEmail, "Billing email", 255, false);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, "Enter a valid billing email");
  return {
    legalName: text(input.legalName, "Company legal name", 150),
    addressLine1: text(input.addressLine1, "Address", 200),
    addressLine2: text(input.addressLine2, "Address line 2", 200, false),
    city: text(input.city, "City", 100),
    stateCode,
    postalCode,
    country: "IN",
    gstin,
    billingEmail: email,
  };
}

// Whole rupees in words, the Indian way (lakh, crore), for the bottom of an invoice.
const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`);
const below1000 = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? " " + below100(n % 100) : ""}` : below100(n));
function wholeWords(n) {
  if (n === 0) return "zero";
  const parts = [];
  for (const [size, name] of [[10000000, "crore"], [100000, "lakh"], [1000, "thousand"]]) {
    if (n >= size) {
      parts.push(`${wholeWords(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}
export function rupeesInWords(amountMinor) {
  const rupees = Math.floor(amountMinor / 100),
    paise = amountMinor % 100;
  const words = `${wholeWords(rupees)} rupees${paise ? ` and ${below100(paise)} paise` : ""} only`;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
