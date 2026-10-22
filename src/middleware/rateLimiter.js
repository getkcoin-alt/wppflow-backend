import rateLimit from 'express-rate-limit';

export const authRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many authentication attempts. Please try again after 1 minute.' }
});

export const sendMessageRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.tenantId || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { status: 'error', message: 'Rate limit exceeded: maximum 60 messages per minute per tenant.' }
});

export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests. Please slow down.' }
});

// The public contact form sits behind the website's proxy, so the visitor is the first
// forwarded address. A spoofed header only buys a spammer their own bucket; the form also
// has a honeypot and a global ceiling.
const visitorOf = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

export const contactFormLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: visitorOf,
  validate: false,
  message: { status: 'error', message: 'You have sent several messages already. Please wait a few minutes and try again.' }
});

export const contactFormCeiling = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'all',
  validate: false,
  message: { status: 'error', message: 'We are receiving a lot of messages right now. Please try again shortly.' }
});
