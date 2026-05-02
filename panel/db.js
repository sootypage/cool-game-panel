const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false
});

function hashToken(token){ return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function newApiKey(){ return `obp_${crypto.randomBytes(32).toString('hex')}`; }

async function initDb(){
  await pool.query(`
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    email text UNIQUE NOT NULL,
    name text NOT NULL,
    role text NOT NULL DEFAULT 'user',
    password_hash text NOT NULL,
    subdomain_slots int NOT NULL DEFAULT 0,
    database_slots int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS nodes (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    url text NOT NULL,
    token text NOT NULL,
    public_ip text,
    location text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS plans (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    kind text NOT NULL,
    price_cents int NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'AUD',
    memory_mb int NOT NULL DEFAULT 1024,
    storage_mb int NOT NULL DEFAULT 10240,
    cpu_limit numeric NOT NULL DEFAULT 1,
    server_type text,
    game_version text,
    docker_image text,
    slots jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS services (
    id uuid PRIMARY KEY,
    owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
    node_id uuid REFERENCES nodes(id) ON DELETE SET NULL,
    plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
    agent_service_id text NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'created',
    server_type text,
    game_version text,
    docker_image text,
    ip_address text,
    port int,
    memory_mb int,
    storage_mb int,
    cpu_limit numeric,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS api_keys (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    prefix text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS subusers (
    id uuid PRIMARY KEY,
    service_id uuid REFERENCES services(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE CASCADE,
    permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(service_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS subdomains (
    id uuid PRIMARY KEY,
    service_id uuid REFERENCES services(id) ON DELETE CASCADE,
    hostname text NOT NULL UNIQUE,
    target text NOT NULL,
    port int,
    owner_domain boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS network_ports (
    id uuid PRIMARY KEY,
    service_id uuid REFERENCES services(id) ON DELETE CASCADE,
    port int NOT NULL,
    protocol text NOT NULL DEFAULT 'tcp',
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(service_id, port, protocol)
  );
  CREATE TABLE IF NOT EXISTS databases (
    id uuid PRIMARY KEY,
    service_id uuid REFERENCES services(id) ON DELETE CASCADE,
    name text NOT NULL,
    engine text NOT NULL DEFAULT 'postgres',
    username text NOT NULL,
    password text NOT NULL,
    host text NOT NULL,
    port int NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(service_id)
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id uuid PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  `);
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const exists = await pool.query('SELECT id FROM users WHERE email=$1', [adminEmail]);
  if (!exists.rows.length) {
    await pool.query('INSERT INTO users(id,email,name,role,password_hash,subdomain_slots,database_slots) VALUES($1,$2,$3,$4,$5,$6,$7)', [uuidv4(), adminEmail, 'Admin', 'admin', await bcrypt.hash(adminPass, 10), 999, 999]);
    console.log(`Created admin ${adminEmail} / ${adminPass}`);
  }
}
module.exports = { pool, initDb, hashToken, newApiKey };
