// Names of communities and the like are compared after this: the same place written in different capitals, with extra
// spaces, punctuation or accents, or with a different form of the Arabic letter alef, is the same place. It never
// translates or guesses: "Marina" and "Dubai Marina" stay different names, and so do an English and an Arabic spelling.
export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[أإآٱ]/g, "ا") // alef with hamza or madda -> bare alef
    .replace(/[ً-ٰٟـ]/g, "") // Arabic vowel marks and the stretching mark
    .normalize("NFD")
    .replace(/(?<=\p{Script=Latin})\p{M}+/gu, "") // é -> e, but leave the vowel signs of Devanagari alone
    .normalize("NFC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

export const sameName = (a, b) => {
  const x = normalizeText(a);
  return x !== "" && x === normalizeText(b);
};

// "AED 1,450,000": money for people to read. Amounts are never converted between currencies.
export const money = (amount, currency) =>
  `${currency} ${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

// Every amount written in a piece of text: "1.5M", "850k", "1,200,000", "1.2 million". Used to check that a number an
// assistant reports was really said by the customer.
export function amountsIn(text) {
  const out = [];
  const re = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(million|thousand|m|k|مليون|الف|ألف)?(?![\p{L}\p{N}])/giu;
  let m;
  while ((m = re.exec(String(text ?? "")))) {
    const factor = { m: 1e6, million: 1e6, مليون: 1e6, k: 1e3, thousand: 1e3, الف: 1e3, ألف: 1e3 }[(m[2] || "").toLowerCase()] || 1;
    const n = Number(m[1].replace(/,/g, "")) * factor;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}
