import 'dotenv/config';

export const ENV = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '8080', 10),
  JWT_SECRET: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'wppflow-dev-insecure-secret-key-32chars!!'),
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || '1h',
  JWT_REFRESH_EXPIRES_IN_DAYS: parseInt(process.env.JWT_REFRESH_EXPIRES_IN_DAYS || '7', 10),
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://localhost:5432/wppflow_test',
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS 
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['http://localhost:5173', 'http://localhost:3000', 'https://wppflow-beige.vercel.app'],
  ENABLE_DEBUG_ROUTES: process.env.ENABLE_DEBUG_ROUTES === 'true',
  TOKEN_DIR: process.env.TOKEN_DIR || '/tmp/wppflow-tokens',
  BODY_LIMIT: process.env.BODY_LIMIT || '2mb',
  ENABLE_DEMO_SEED: process.env.ENABLE_DEMO_SEED === 'true'
};

if (ENV.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('❌ FATAL: JWT_SECRET environment variable is missing or too short in production (min 32 chars).');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('❌ FATAL: DATABASE_URL environment variable is required in production.');
    process.exit(1);
  }
}
