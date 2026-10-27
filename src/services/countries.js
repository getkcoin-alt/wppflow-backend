// Which country a WhatsApp number belongs to, from its calling code. WhatsApp numbers are stored as plain digits with the
// country code first ("971501234567"). Calling codes are prefix-free (no code is the start of another), so the country
// is read by checking the first one, two and three digits: there is never more than one answer.
//
// A number can share its code with neighbours (+1 is the United States, Canada and much of the Caribbean; +7 is Russia
// and Kazakhstan). That is fine for the question we ask, "is this the company's own country or not?", because the company
// chooses codes, not countries.
const CODES = {
  1: "United States, Canada and the Caribbean",
  7: "Russia and Kazakhstan",
  20: "Egypt", 27: "South Africa", 30: "Greece", 31: "Netherlands", 32: "Belgium", 33: "France", 34: "Spain", 36: "Hungary",
  39: "Italy", 40: "Romania", 41: "Switzerland", 43: "Austria", 44: "United Kingdom", 45: "Denmark", 46: "Sweden", 47: "Norway",
  48: "Poland", 49: "Germany", 51: "Peru", 52: "Mexico", 53: "Cuba", 54: "Argentina", 55: "Brazil", 56: "Chile", 57: "Colombia",
  58: "Venezuela", 60: "Malaysia", 61: "Australia", 62: "Indonesia", 63: "Philippines", 64: "New Zealand", 65: "Singapore",
  66: "Thailand", 81: "Japan", 82: "South Korea", 84: "Vietnam", 86: "China", 90: "Türkiye", 91: "India", 92: "Pakistan",
  93: "Afghanistan", 94: "Sri Lanka", 95: "Myanmar", 98: "Iran",
  211: "South Sudan", 212: "Morocco", 213: "Algeria", 216: "Tunisia", 218: "Libya", 220: "Gambia", 221: "Senegal",
  222: "Mauritania", 223: "Mali", 224: "Guinea", 225: "Côte d'Ivoire", 226: "Burkina Faso", 227: "Niger", 228: "Togo",
  229: "Benin", 230: "Mauritius", 231: "Liberia", 232: "Sierra Leone", 233: "Ghana", 234: "Nigeria", 235: "Chad",
  236: "Central African Republic", 237: "Cameroon", 238: "Cape Verde", 239: "São Tomé and Príncipe", 240: "Equatorial Guinea",
  241: "Gabon", 242: "Republic of the Congo", 243: "DR Congo", 244: "Angola", 245: "Guinea-Bissau", 248: "Seychelles",
  249: "Sudan", 250: "Rwanda", 251: "Ethiopia", 252: "Somalia", 253: "Djibouti", 254: "Kenya", 255: "Tanzania", 256: "Uganda",
  257: "Burundi", 258: "Mozambique", 260: "Zambia", 261: "Madagascar", 262: "Réunion and Mayotte", 263: "Zimbabwe",
  264: "Namibia", 265: "Malawi", 266: "Lesotho", 267: "Botswana", 268: "Eswatini", 269: "Comoros", 290: "Saint Helena",
  291: "Eritrea", 297: "Aruba", 298: "Faroe Islands", 299: "Greenland",
  350: "Gibraltar", 351: "Portugal", 352: "Luxembourg", 353: "Ireland", 354: "Iceland", 355: "Albania", 356: "Malta",
  357: "Cyprus", 358: "Finland", 359: "Bulgaria", 370: "Lithuania", 371: "Latvia", 372: "Estonia", 373: "Moldova",
  374: "Armenia", 375: "Belarus", 376: "Andorra", 377: "Monaco", 378: "San Marino", 380: "Ukraine", 381: "Serbia",
  382: "Montenegro", 383: "Kosovo", 385: "Croatia", 386: "Slovenia", 387: "Bosnia and Herzegovina", 389: "North Macedonia",
  420: "Czechia", 421: "Slovakia", 423: "Liechtenstein",
  500: "Falkland Islands", 501: "Belize", 502: "Guatemala", 503: "El Salvador", 504: "Honduras", 505: "Nicaragua",
  506: "Costa Rica", 507: "Panama", 508: "Saint Pierre and Miquelon", 509: "Haiti", 590: "Guadeloupe", 591: "Bolivia",
  592: "Guyana", 593: "Ecuador", 594: "French Guiana", 595: "Paraguay", 596: "Martinique", 597: "Suriname", 598: "Uruguay",
  599: "Curaçao",
  670: "Timor-Leste", 672: "Australian external territories", 673: "Brunei", 674: "Nauru", 675: "Papua New Guinea",
  676: "Tonga", 677: "Solomon Islands", 678: "Vanuatu", 679: "Fiji", 680: "Palau", 681: "Wallis and Futuna",
  682: "Cook Islands", 683: "Niue", 685: "Samoa", 686: "Kiribati", 687: "New Caledonia", 688: "Tuvalu", 689: "French Polynesia",
  690: "Tokelau", 691: "Micronesia", 692: "Marshall Islands",
  850: "North Korea", 852: "Hong Kong", 853: "Macao", 855: "Cambodia", 856: "Laos", 880: "Bangladesh", 886: "Taiwan",
  960: "Maldives", 961: "Lebanon", 962: "Jordan", 963: "Syria", 964: "Iraq", 965: "Kuwait", 966: "Saudi Arabia", 967: "Yemen",
  968: "Oman", 970: "Palestine", 971: "United Arab Emirates", 972: "Israel", 973: "Bahrain", 974: "Qatar", 975: "Bhutan",
  976: "Mongolia", 977: "Nepal", 992: "Tajikistan", 993: "Turkmenistan", 994: "Azerbaijan", 995: "Georgia",
  996: "Kyrgyzstan", 998: "Uzbekistan",
};

export const COUNTRIES = Object.entries(CODES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const isCallingCode = (code) => typeof code === "string" && Object.hasOwn(CODES, code);
export const countryName = (code) => CODES[code] || "";
export const countryLabel = (code) => (isCallingCode(code) ? `${CODES[code]} (+${code})` : `+${code}`);

// "971501234567" gives "971". Returns null when the digits are not a number we can place: too short or too long to be a
// phone number, or beginning with a code nobody uses. WhatsApp's hidden "linked" ids look like long random digit strings,
// and must never be taken for a foreign customer.
export function callingCodeOf(phone) {
  // an ordinary number, or WhatsApp's own id for one ("971501234567@c.us", or with a device: "971501234567:12@c.us").
  // A linked id ("…@lid") or a group id is not a number, however many digits it has.
  const raw = String(phone ?? "").trim().replace(/(?::\d+)?@c\.us$/, "");
  if (!/^\+?[\d\s().-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  for (const length of [1, 2, 3]) {
    const prefix = digits.slice(0, length);
    if (isCallingCode(prefix)) return prefix;
  }
  return null;
}

// Is this number from outside the given home codes? Only a number whose country is known can be foreign.
export function isForeignNumber(phone, homeCodes) {
  const code = callingCodeOf(phone);
  return code !== null && !homeCodes.includes(code);
}

// What the browser sent for "my country" becomes a clean list of codes, or says what is wrong. "+971", "971" and 971 are
// the same. An empty list is refused: a rule that cannot tell "foreign" from "home" would greet everyone.
export function cleanHomeCodes(value) {
  const list = (Array.isArray(value) ? value : [])
    .map((v) => String(v ?? "").replace(/\D/g, ""))
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) return { error: "Choose the country you are in, so we know which numbers are from abroad" };
  if (unique.length > 8) return { error: "Choose up to 8 countries as your own" };
  const unknown = unique.find((c) => !isCallingCode(c));
  if (unknown) return { error: `+${unknown} isn't a country calling code` };
  return { codes: unique };
}
