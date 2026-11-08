// The ready-made OTP messages. The wording is fixed: the only things that change are the company's name and the code, so a free
// code service cannot be used to send anything else (a link, an offer, a warning that is not ours). The code is on the first line
// and in bold so it shows in the phone's notification and is easy to copy.
export const LOCALES = ["en", "hi", "ar"];
export const LOCALE_NAMES = { en: "English", hi: "हिन्दी", ar: "العربية" };

// key, what the person sees on the tile, and what the template sets up (digits, minutes to expiry, tries, seconds before a resend)
export const TEMPLATES = [
  { key: "login", title: "Sign in", blurb: "Let people log in with a code instead of a password.", defaults: { codeLength: 6, ttlSeconds: 300, maxAttempts: 5, resendSeconds: 30 } },
  { key: "signup", title: "Sign up", blurb: "Check a new account's phone number before it is created.", defaults: { codeLength: 6, ttlSeconds: 600, maxAttempts: 5, resendSeconds: 30 } },
  { key: "reset", title: "Password reset", blurb: "Prove it is them before choosing a new password.", defaults: { codeLength: 6, ttlSeconds: 600, maxAttempts: 3, resendSeconds: 60 } },
  { key: "payment", title: "Payment", blurb: "Confirm a payment or a transfer.", defaults: { codeLength: 6, ttlSeconds: 300, maxAttempts: 3, resendSeconds: 60 } },
  { key: "delivery", title: "Delivery", blurb: "The code a customer gives the courier when the order arrives.", defaults: { codeLength: 4, ttlSeconds: 3600, maxAttempts: 5, resendSeconds: 60 } },
  { key: "booking", title: "Booking", blurb: "Confirm an appointment, a table or a ticket.", defaults: { codeLength: 6, ttlSeconds: 600, maxAttempts: 5, resendSeconds: 30 } },
  { key: "change", title: "Account change", blurb: "Confirm a new phone number, email or address.", defaults: { codeLength: 6, ttlSeconds: 300, maxAttempts: 3, resendSeconds: 60 } },
  { key: "verify", title: "Verify my number", blurb: "A plain check that the number is theirs.", defaults: { codeLength: 6, ttlSeconds: 300, maxAttempts: 5, resendSeconds: 30 } },
];
export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);
export const templateOf = (key) => TEMPLATES.find((t) => t.key === key) || null;

// what the code is called, per language: {brand} is the company's name
const WHAT = {
  en: { login: "your {brand} sign-in code", signup: "your {brand} verification code", reset: "your {brand} password reset code", payment: "your {brand} payment confirmation code", delivery: "your {brand} delivery code", booking: "your {brand} booking confirmation code", change: "your {brand} code to confirm this change", verify: "your {brand} verification code" },
  hi: { login: "आपका {brand} साइन-इन कोड", signup: "आपका {brand} सत्यापन कोड", reset: "आपका {brand} पासवर्ड रीसेट कोड", payment: "आपका {brand} भुगतान पुष्टि कोड", delivery: "आपका {brand} डिलीवरी कोड", booking: "आपका {brand} बुकिंग पुष्टि कोड", change: "इस बदलाव की पुष्टि के लिए आपका {brand} कोड", verify: "आपका {brand} सत्यापन कोड" },
  ar: { login: "رمز تسجيل الدخول إلى {brand}", signup: "رمز التحقق الخاص بك في {brand}", reset: "رمز إعادة تعيين كلمة المرور في {brand}", payment: "رمز تأكيد الدفع في {brand}", delivery: "رمز التسليم الخاص بك من {brand}", booking: "رمز تأكيد الحجز في {brand}", change: "رمز تأكيد هذا التغيير في {brand}", verify: "رمز التحقق الخاص بك في {brand}" },
};
// "{code} is ...": the first line
const IS = { en: (code, what) => `*${code}* is ${what}.`, hi: (code, what) => `*${code}* ${what} है।`, ar: (code, what) => `*${code}* هو ${what}.` };
const CAUTION = {
  en: "Never share this code with anyone.",
  hi: "यह कोड किसी के साथ साझा न करें।",
  ar: "لا تشارك هذا الرمز مع أي شخص.",
};
const DELIVERY = {
  en: "Give it to the delivery person only when your order arrives.",
  hi: "डिलीवरी करने वाले व्यक्ति को यह कोड तभी दें जब आपका ऑर्डर पहुँच जाए।",
  ar: "أعطِ هذا الرمز لموظف التوصيل فقط عند وصول طلبك.",
};

// "5 minutes", "1 hour", in each language (Arabic has its own forms for one, two, a few and many)
export function duration(seconds, locale = "en") {
  const hours = seconds >= 3600 && seconds % 3600 === 0 ? seconds / 3600 : 0;
  const n = hours || Math.max(1, Math.ceil(seconds / 60));
  if (locale === "hi") return hours ? `${n} घंटे` : `${n} मिनट`;
  if (locale === "ar") {
    if (hours) return n === 1 ? "ساعة واحدة" : n === 2 ? "ساعتين" : `${n} ساعات`;
    return n === 1 ? "دقيقة واحدة" : n === 2 ? "دقيقتين" : n <= 10 ? `${n} دقائق` : `${n} دقيقة`;
  }
  return hours ? `${n} hour${n === 1 ? "" : "s"}` : `${n} minute${n === 1 ? "" : "s"}`;
}
const EXPIRES = {
  en: (d) => `It expires in ${d}.`,
  hi: (d) => `यह ${d} में समाप्त हो जाएगा।`,
  ar: (d) => `تنتهي صلاحيته خلال ${d}.`,
};

// The company's name as it appears in the message: letters, numbers, spaces, & - and ', so it can never be a link, an address or
// a number to call. A name taken from the company's profile is cleaned to this; a name typed on purpose that does not fit is refused.
export const BRAND_RULE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} &'-]{1,29}$/u;
export const cleanBrand = (value) => String(value ?? "").normalize("NFC").replace(/[^\p{L}\p{M}\p{N} &'-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 30).trim();
export const brandProblem = (value) => {
  const brand = String(value ?? "").trim();
  if (!BRAND_RULE.test(brand)) return "Use 2 to 30 letters, numbers, spaces, & - or ' (no links, dots or symbols).";
  return "";
};

// "your {brand} sign-in code" without a name: "your sign-in code" (and the Arabic "... in {brand}" without its dangling word)
const unbranded = (s) => s.replace(/\s*(?:في|إلى|من)\s*\{brand\}/u, "").replace(/\s*\{brand\}\s*/u, " ").replace(/\s+/g, " ").trim();

export function renderOtp({ template = "login", locale = "en", brand, code, ttlSeconds = 300 }) {
  const t = templateOf(template) ? template : "login";
  const l = LOCALES.includes(locale) ? locale : "en";
  const name = cleanBrand(brand);
  const first = IS[l](code, name ? WHAT[l][t].replace("{brand}", name) : unbranded(WHAT[l][t]));
  const second = t === "delivery" ? `${DELIVERY[l]} ${EXPIRES[l](duration(ttlSeconds, l))}` : `${EXPIRES[l](duration(ttlSeconds, l))} ${CAUTION[l]}`;
  return `${first}\n${second}`;
}

// "+971 50 123 4567" -> "+971•••••4567": enough to recognise, not enough to use
export const maskPhone = (digits) => {
  const d = String(digits ?? "").replace(/\D/g, "");
  if (d.length < 8) return "+•••";
  return `+${d.slice(0, 3)}${"•".repeat(Math.max(3, d.length - 7))}${d.slice(-4)}`;
};
