import pg from 'pg';
import bcrypt from 'bcryptjs';

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
let isPgConnected = false;

// In-memory fallback if PostgreSQL is not reachable or still booting
const memoryUsers = new Map();

// Helper to hash password
export async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

export async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// Initialize Database connection & Schema
export async function initDatabase() {
  console.log('🔄 Initializing Database Layer...');
  
  if (DATABASE_URL) {
    try {
      pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: DATABASE_URL.includes('railway') || DATABASE_URL.includes('sslmode=require') 
          ? false // internal Railway network does not need TLS
          : undefined,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000
      });

      // Test connection
      const client = await pool.connect();
      console.log('✅ Connected to PostgreSQL database successfully!');
      isPgConnected = true;

      // Create users table if not exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          company_name VARCHAR(255) DEFAULT 'WppFlow Workspace',
          role VARCHAR(50) DEFAULT 'user',
          plan VARCHAR(50) DEFAULT 'Growth',
          sessions_limit INT DEFAULT 5,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('✅ PostgreSQL Schema verified: "users" table ready.');

      client.release();
    } catch (err) {
      console.warn(`⚠️ PostgreSQL connection attempt failed (${err.message}). Using resilient in-memory store.`);
      isPgConnected = false;
    }
  } else {
    console.log('ℹ️ No DATABASE_URL provided. Using memory store for development.');
  }

  // Seed default admin and demo user
  await seedDefaultUsers();
}

async function seedDefaultUsers() {
  const adminHash = await hashPassword('admin123');
  const demoHash = await hashPassword('demo123');

  if (isPgConnected && pool) {
    try {
      const { rows } = await pool.query('SELECT COUNT(*) FROM users');
      if (parseInt(rows[0].count, 10) === 0) {
        await pool.query(`
          INSERT INTO users (email, password_hash, name, company_name, role, plan, sessions_limit)
          VALUES 
            ('admin@wppflow.io', $1, 'Super Admin', 'WppFlow HQ', 'admin', 'Enterprise', 25),
            ('demo@wppflow.io', $2, 'Aarav Mehta', 'Urban Threads', 'user', 'Growth', 5)
        `, [adminHash, demoHash]);
        console.log('🌱 Seeded default users (admin@wppflow.io / demo@wppflow.io) into PostgreSQL');
      }
    } catch (err) {
      console.error('Error seeding PG users:', err.message);
    }
  }

  // Always seed memory fallback
  memoryUsers.set('admin@wppflow.io', {
    id: 1,
    email: 'admin@wppflow.io',
    password_hash: adminHash,
    name: 'Super Admin',
    company_name: 'WppFlow HQ',
    role: 'admin',
    plan: 'Enterprise',
    sessions_limit: 25,
    created_at: new Date().toISOString()
  });

  memoryUsers.set('demo@wppflow.io', {
    id: 2,
    email: 'demo@wppflow.io',
    password_hash: demoHash,
    name: 'Aarav Mehta',
    company_name: 'Urban Threads',
    role: 'user',
    plan: 'Growth',
    sessions_limit: 5,
    created_at: new Date().toISOString()
  });
}

// User CRUD operations
export async function createUser({ email, password, name, company_name = 'WppFlow Workspace', role = 'user', plan = 'Growth', sessions_limit = 5 }) {
  const password_hash = await hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();

  if (isPgConnected && pool) {
    try {
      const res = await pool.query(`
        INSERT INTO users (email, password_hash, name, company_name, role, plan, sessions_limit)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, email, name, company_name, role, plan, sessions_limit, created_at
      `, [normalizedEmail, password_hash, name.trim(), company_name.trim(), role, plan, sessions_limit]);
      
      const user = res.rows[0];
      // Keep memory in sync
      memoryUsers.set(normalizedEmail, { ...user, password_hash });
      return user;
    } catch (err) {
      if (err.code === '23505') {
        throw new Error('Email already registered');
      }
      console.warn('PG write error, falling back to memory:', err.message);
    }
  }

  // Memory fallback
  if (memoryUsers.has(normalizedEmail)) {
    throw new Error('Email already registered');
  }

  const newUser = {
    id: memoryUsers.size + 1,
    email: normalizedEmail,
    password_hash,
    name: name.trim(),
    company_name: company_name.trim(),
    role,
    plan,
    sessions_limit,
    created_at: new Date().toISOString()
  };

  memoryUsers.set(normalizedEmail, newUser);
  const { password_hash: _, ...safeUser } = newUser;
  return safeUser;
}

export async function findUserByEmail(email) {
  const normalizedEmail = email.trim().toLowerCase();

  if (isPgConnected && pool) {
    try {
      const res = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
      if (res.rows.length > 0) return res.rows[0];
    } catch (err) {
      console.warn('PG read error, falling back to memory:', err.message);
    }
  }

  return memoryUsers.get(normalizedEmail) || null;
}

export async function findUserById(id) {
  if (isPgConnected && pool) {
    try {
      const res = await pool.query(
        'SELECT id, email, name, company_name, role, plan, sessions_limit, created_at FROM users WHERE id = $1', 
        [id]
      );
      if (res.rows.length > 0) return res.rows[0];
    } catch (err) {
      console.warn('PG read error, falling back to memory:', err.message);
    }
  }

  for (const user of memoryUsers.values()) {
    if (user.id === Number(id)) {
      const { password_hash: _, ...safeUser } = user;
      return safeUser;
    }
  }
  return null;
}

export async function getAllUsers() {
  if (isPgConnected && pool) {
    try {
      const res = await pool.query(
        'SELECT id, email, name, company_name, role, plan, sessions_limit, created_at FROM users ORDER BY id DESC'
      );
      return res.rows;
    } catch (err) {
      console.warn('PG read error, falling back to memory:', err.message);
    }
  }

  return Array.from(memoryUsers.values()).map(({ password_hash: _, ...safeUser }) => safeUser);
}

export function getDatabaseStatus() {
  return {
    isPgConnected,
    type: isPgConnected ? 'PostgreSQL' : 'In-Memory (Fault Tolerant)',
    totalUsers: isPgConnected ? 'Postgres Active' : memoryUsers.size
  };
}
