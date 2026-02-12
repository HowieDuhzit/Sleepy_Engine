import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

export const dbEnabled = Boolean(databaseUrl);

export const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: Number(process.env.DB_POOL_SIZE ?? 10),
    })
  : null;

export const dbHealth = async () => {
  if (!pool) return { enabled: false };
  try {
    await pool.query('SELECT 1');
    return { enabled: true, ok: true };
  } catch (err) {
    return { enabled: true, ok: false, error: String(err) };
  }
};

export const closeDb = async () => {
  if (!pool) return;
  await pool.end();
};
