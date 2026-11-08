import test from "node:test";
import assert from "node:assert/strict";
import { TEMPLATES, TEMPLATE_KEYS, LOCALES, renderOtp, duration, cleanBrand, brandProblem, maskPhone } from "../src/services/otp/templates.js";

test("every use case reads well in every language: the code first and in bold, the name once, the expiry, a caution", () => {
  assert.equal(TEMPLATES.length, 8);
  for (const key of TEMPLATE_KEYS)
    for (const locale of LOCALES) {
      const text = renderOtp({ template: key, locale, brand: "Acme Stores", code: "482913", ttlSeconds: 300 });
      const [first, second, ...rest] = text.split("\n");
      assert.ok(first.startsWith("*482913*"), `${key}/${locale}: the code is the first thing in the message (so the notification shows it)`);
      assert.equal(rest.length, 0, `${key}/${locale}: two lines`);
      assert.ok(second.length > 10);
      assert.equal(text.split("Acme Stores").length - 1, 1, `${key}/${locale}: the company's name appears once`);
      assert.ok(!/\{|\}/.test(text), `${key}/${locale}: nothing left unfilled`);
    }
});

test("the wording is fixed: only the name and the code can change, so the service cannot carry anything else", () => {
  const withLink = renderOtp({ template: "login", brand: "Acme https://evil.example", code: "123456" });
  assert.ok(!/https?:|evil\.example|:\/\//.test(withLink), "a link in the name never reaches the message");
  assert.equal(cleanBrand("Acme Pvt. Ltd. <b>"), "Acme Pvt Ltd b");
  assert.equal(cleanBrand("   "), "");
});

test("a name that is not a plain name is refused when typed on purpose", () => {
  assert.equal(brandProblem("Acme Stores"), "");
  assert.equal(brandProblem("Café Noor & Sons"), "");
  assert.equal(brandProblem("मेरी दुकान"), "");
  assert.equal(brandProblem("متجر الأمل"), "");
  for (const bad of ["", "A", "shop.example.com", "http://x.co", "a".repeat(31), "Acme_Stores", "Acme\nStores", "Acme <b>", "Acme @acme"]) assert.ok(brandProblem(bad), `refused: ${JSON.stringify(bad)}`);
});

test("a company with no usable name still gets a message that reads properly", () => {
  const en = renderOtp({ template: "login", brand: "", code: "111111" });
  assert.match(en, /is your sign-in code/);
  const ar = renderOtp({ template: "login", locale: "ar", brand: "", code: "111111" });
  assert.ok(!/\{brand\}/.test(ar));
});

test("the delivery message tells the person to give the code to the courier, the others to keep it to themselves", () => {
  assert.match(renderOtp({ template: "delivery", brand: "Acme", code: "4821", ttlSeconds: 3600 }), /delivery person only when your order arrives/);
  assert.match(renderOtp({ template: "login", brand: "Acme", code: "482913" }), /Never share this code with anyone/);
  assert.match(renderOtp({ template: "delivery", locale: "hi", brand: "Acme", code: "4821", ttlSeconds: 3600 }), /डिलीवरी/);
  assert.match(renderOtp({ template: "login", locale: "ar", brand: "Acme", code: "482913" }), /لا تشارك/);
});

test("how long a code lasts is said in the person's own language", () => {
  assert.equal(duration(60), "1 minute");
  assert.equal(duration(300), "5 minutes");
  assert.equal(duration(90), "2 minutes");
  assert.equal(duration(3600), "1 hour");
  assert.equal(duration(7200), "2 hours");
  assert.equal(duration(300, "hi"), "5 मिनट");
  assert.equal(duration(60, "ar"), "دقيقة واحدة");
  assert.equal(duration(120, "ar"), "دقيقتين");
  assert.equal(duration(300, "ar"), "5 دقائق");
  assert.equal(duration(900, "ar"), "15 دقيقة");
  assert.equal(duration(3600, "ar"), "ساعة واحدة");
});

test("a phone number is masked to what a person can recognise and nobody can use", () => {
  assert.equal(maskPhone("971501234567"), "+971•••••4567");
  assert.equal(maskPhone("919971694047"), "+919•••••4047");
  assert.equal(maskPhone("123"), "+•••");
});

test("each use case sets sensible limits", () => {
  for (const t of TEMPLATES) {
    assert.ok(t.defaults.codeLength >= 4 && t.defaults.codeLength <= 8);
    assert.ok(t.defaults.ttlSeconds >= 60 && t.defaults.ttlSeconds <= 3600);
    assert.ok(t.defaults.maxAttempts >= 1 && t.defaults.maxAttempts <= 10);
    assert.ok(t.defaults.resendSeconds >= 15 && t.defaults.resendSeconds <= 300);
  }
});
